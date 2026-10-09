import { logger } from "../../lib/logger.js";
import { canonicalContainerId } from "./container-reservations.js";
import {
  getMiningAssignments,
  removeMiningAssignment,
  upsertMiningAssignment,
} from "./file-store.js";
import {
  updateDroneRoleState,
  type DroneRole,
} from "./drone-roles-store.js";
import { BALL_EXPLORER_RETURN_FUEL_PERCENT } from "./drone-role-runner.js";

export const BALL_EXPLORER_REPAIR_MINING_HULL_PERCENT = 25;

export type EmergencyMiningDeps = {
  getMiningAssignments: typeof getMiningAssignments;
  removeMiningAssignment: typeof removeMiningAssignment;
  upsertMiningAssignment: typeof upsertMiningAssignment;
  updateDroneRoleState: typeof updateDroneRoleState;
};

const defaultDeps: EmergencyMiningDeps = {
  getMiningAssignments,
  removeMiningAssignment,
  upsertMiningAssignment,
  updateDroneRoleState,
};

export type EmergencyMiningSyncResult = {
  /** Stop adding miners and recover the current container cycle. */
  stopAfterCycle: boolean;
};

function fuelPercent(probe: any): number {
  const fuel = Number(probe?.fuel?.deuterium);
  const capacity = Number(probe?.fuel?.maxDeuterium);
  const maxFuel = Number.isFinite(capacity) && capacity > 0 ? capacity : 100;
  return (Math.max(0, Number.isFinite(fuel) ? fuel : 0) / maxFuel) * 100;
}

function containerInventory(probe: any): any[] {
  return (probe?.inventory?.containers ?? []).filter(
    (container: any) =>
      typeof container?.id === "string" &&
      ((typeof container.kind === "string" &&
        container.kind.toLowerCase().includes("container")) ||
        Number(container.capacity) > 0),
  );
}

function isEmptyContainer(container: any): boolean {
  const capacity = Number(container?.capacity);
  const usedCapacity = Number(container?.usedCapacity ?? container?.used);
  return Number.isFinite(capacity) &&
    capacity > 0 &&
    Number.isFinite(usedCapacity) &&
    usedCapacity <= 0;
}

function isFuelReturnPhase(role: DroneRole | undefined): boolean {
  return Boolean(
    role &&
      (role.state.phase === "returning_for_fuel" ||
        role.state.phase === "waiting_for_fuel" ||
        role.state.fuelReturnStage),
  );
}

export async function syncBallExplorerEmergencyMining(
  args: {
    probeId: number | null;
    role?: DroneRole;
    probe: any;
    isMoving: boolean;
    protectedContainerIds: Set<string>;
    requestRolePoll?: (probeIds?: number[]) => void;
  },
  deps: EmergencyMiningDeps = defaultDeps,
): Promise<EmergencyMiningSyncResult> {
  const { probeId, role, probe, isMoving, protectedContainerIds, requestRolePoll } = args;
  if (probeId == null) return { stopAfterCycle: false };

  const assignments = await deps.getMiningAssignments();
  let automaticAssignment = assignments.find(
    (assignment) => assignment.emergencyRepairProbeId === probeId,
  );
  const inventory = containerInventory(probe);
  const inventoryIds = new Set(
    inventory.map((container) => canonicalContainerId(container.id)),
  );
  const integrity = Number(probe?.systems?.integrityPercent);
  const hullIsLow =
    Number.isFinite(integrity) &&
    integrity < BALL_EXPLORER_REPAIR_MINING_HULL_PERCENT;
  const phaseAllowsMining = Boolean(
    role &&
      ["idle", "scanning", "mining_for_repair"].includes(role.state.phase),
  );
  const fuelIsSafe =
    fuelPercent(probe) > BALL_EXPLORER_RETURN_FUEL_PERCENT &&
    !isFuelReturnPhase(role);
  const shouldWaitForRepair =
    Boolean(role?.enabled) && hullIsLow && phaseAllowsMining && fuelIsSafe;
  const shouldRunMining = shouldWaitForRepair && !isMoving;

  const manualMetalsAssignment = assignments.some(
    (assignment) =>
      assignment.probeId === probeId &&
      assignment.enabled &&
      assignment.material === "metals" &&
      assignment.emergencyRepairProbeId == null,
  );

  if (shouldWaitForRepair && role && role.state.phase !== "mining_for_repair") {
    const resumePhase = role.state.phase;
    const status = manualMetalsAssignment
      ? "Hull below 25%; using the configured metals mining assignment"
      : "Hull below 25%; preparing to mine metals for hull repair";
    await deps.updateDroneRoleState(role.id, {
      phase: "mining_for_repair",
      emergencyMetalMiningResumePhase: resumePhase,
      lastError: status,
    });
    role.state = {
      ...role.state,
      phase: "mining_for_repair",
      emergencyMetalMiningResumePhase: resumePhase,
      lastError: status,
    };
    requestRolePoll?.([probeId]);
  }

  if (shouldRunMining && role && !automaticAssignment && !manualMetalsAssignment) {
    const assignedContainerIds = new Set(
      assignments.map((assignment) =>
        canonicalContainerId(assignment.containerId),
      ),
    );
    const protectedIds = new Set(
      [
        ...protectedContainerIds,
        ...(role.state.ballRepairReserveContainerId
          ? [role.state.ballRepairReserveContainerId]
          : []),
      ].map(canonicalContainerId),
    );
    const spare = inventory.find((container) => {
      const id = canonicalContainerId(container.id);
      const label = String(container.name ?? container.label ?? "").toLowerCase();
      return (
        isEmptyContainer(container) &&
        !/\b(metal|repair|reserve)\b/.test(label) &&
        !assignedContainerIds.has(id) &&
        !protectedIds.has(id)
      );
    });

    if (spare) {
      try {
        automaticAssignment = await deps.upsertMiningAssignment({
          containerId: String(spare.id),
          containerName: `Emergency metals for ${role.probeName ?? probe?.name ?? probeId}`,
          material: "metals",
          mannyCount: 1,
          probeId,
          enabled: true,
          assignmentMode: "mine",
          cycleState: "idle",
          emergencyRepairProbeId: probeId,
          containerCapacity: Number(spare.capacity),
        });
        logger.info(
          {
            probeId,
            assignmentId: automaticAssignment.id,
            containerId: spare.id,
          },
          "drone-role: started emergency metals mining for low hull",
        );
      } catch (err: any) {
        logger.warn(
          { probeId, containerId: spare.id, err: err?.message },
          "drone-role: could not create emergency metals mining assignment",
        );
      }
    }

    if (
      !automaticAssignment &&
      role.state.lastError !==
        "Hull below 25%; waiting for an unused empty container to mine metals"
    ) {
      await deps.updateDroneRoleState(role.id, {
        lastError:
          "Hull below 25%; waiting for an unused empty container to mine metals",
      });
    }
  }

  const shouldAbortMining = Boolean(
    automaticAssignment &&
      (!shouldWaitForRepair || isMoving),
  );
  const containerReturned =
    automaticAssignment &&
    inventoryIds.has(canonicalContainerId(automaticAssignment.containerId));

  if (automaticAssignment && shouldAbortMining && containerReturned) {
    await deps.removeMiningAssignment(automaticAssignment.id);
    logger.info(
      {
        probeId,
        assignmentId: automaticAssignment.id,
        hullIntegrity: Number.isFinite(integrity) ? integrity : null,
      },
      "drone-role: emergency metals container returned; ending mining assignment",
    );
    automaticAssignment = undefined;
  }

  if (
    role?.state.phase === "mining_for_repair" &&
    !shouldWaitForRepair &&
    !automaticAssignment &&
    integrity >= BALL_EXPLORER_REPAIR_MINING_HULL_PERCENT
  ) {
    const resumePhase = role.state.emergencyMetalMiningResumePhase ?? "scanning";
    await deps.updateDroneRoleState(role.id, {
      phase: resumePhase,
      emergencyMetalMiningResumePhase: undefined,
      lastError: undefined,
    });
    role.state = {
      ...role.state,
      phase: resumePhase,
      emergencyMetalMiningResumePhase: undefined,
      lastError: undefined,
    };
    requestRolePoll?.([probeId]);
  }

  return {
    stopAfterCycle: Boolean(automaticAssignment && shouldAbortMining),
  };
}

