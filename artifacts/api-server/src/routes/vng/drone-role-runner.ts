/**
 * Drone Role Automation Runner
 *
 * Called once per probe per poll tick.  Each role type has its own state
 * machine; state is persisted between ticks via drone-roles-store.
 *
 * Repair in transit: every drone repairs damaged Mannies at the start of
 * every tick, regardless of travel status.
 */

import { logger } from "../../lib/logger.js";
import { clientFor, VngApiError } from "./client.js";
import {
  getDroneRoleByProbeId,
  getDroneRoles,
  updateDroneRoleState,
  getPendingDeliveryRequest,
  addDeliveryRequest,
  updateDeliveryRequest,
  getDeliveryRequests,
} from "./drone-roles-store.js";
import type {
  DroneRole,
  RefuelConfig,
  DeliveryConfig,
  ExplorerConfig,
  FactoryConfig,
} from "./drone-roles-store.js";

const MOVING_STATUSES = new Set(["accelerating", "cruising", "decelerating"]);
const MIN_DEUTERIUM_RESERVE = 5; // always keep this much before transferring

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when an inventory item is a storage container (the live game uses
 *  `additional_container`; older data may use `storage_container`). */
export function isContainerItem(i: any): boolean {
  return (
    i?.type === "storage_container" ||
    i?.type === "additional_container" ||
    i?.category === "container"
  );
}

function pickIdleManny(mannies: any[], claimed: Set<string>): any | null {
  return (
    mannies.find(
      (m) =>
        !claimed.has(m.id) &&
        (m.currentTask == null || m.currentTask === "idle"),
    ) ?? null
  );
}

function sectorKey(s: { x: number; y: number; z: number }): string {
  return `${s.x},${s.y},${s.z}`;
}

function atSector(
  probe: any,
  target: { x: number; y: number; z: number },
): boolean {
  const s = probe?.sector;
  return s != null && s.x === target.x && s.y === target.y && s.z === target.z;
}

/** Next sector toward target, one step per axis direction. */
function nextSectorToward(
  current: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: current.x + Math.sign(target.x - current.x),
    y: current.y + Math.sign(target.y - current.y),
    z: current.z + Math.sign(target.z - current.z),
  };
}

function reachedTarget(
  current: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): boolean {
  return (
    current.x === target.x &&
    current.y === target.y &&
    current.z === target.z
  );
}

/** Repair up to one damaged Manny per tick (works while probe is moving). */
async function repairDamagedMannies(
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  label: string,
): Promise<void> {
  for (const m of mannies) {
    if (claimed.has(m.id)) continue;
    const integrity = m.integrityPercent ?? 100;
    if (
      integrity < 99 &&
      (m.currentTask == null || m.currentTask === "idle")
    ) {
      try {
        await c.repairManny(m.id, 100);
        claimed.add(m.id);
        logger.info({ label, mannyId: m.id, integrity }, "drone-role: repairing manny");
        return; // one per tick
      } catch (err: any) {
        if (!(err instanceof VngApiError && err.status === 409)) {
          logger.warn({ label, err: err?.message }, "drone-role: repair manny failed");
        }
      }
    }
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runDroneRoleAutomation(
  probeId: number | null,
  probe: any,
  mannies: any[],
  c: ReturnType<typeof clientFor>,
): Promise<void> {
  if (probeId == null) return;

  const role = await getDroneRoleByProbeId(probeId).catch(() => null);
  if (!role) return;

  const label = `drone-role ${role.roleType} (probe ${probeId})`;
  const claimed = new Set<string>();
  const isMoving = MOVING_STATUSES.has(probe?.status ?? "");

  // Always repair regardless of phase or movement status.
  await repairDamagedMannies(mannies, claimed, c, label);

  try {
    if (role.roleType === "refuel") {
      await runRefuelRole(role, probe, mannies, claimed, c, isMoving, label);
    } else if (role.roleType === "delivery") {
      await runDeliveryRole(role, probe, mannies, claimed, c, isMoving, label);
    } else if (role.roleType === "explorer") {
      await runExplorerRole(role, probe, mannies, claimed, c, isMoving, label);
    } else if (role.roleType === "factory") {
      await runFactoryRole(role, probe, mannies, claimed, c, isMoving, label);
    }
  } catch (err: any) {
    if (err instanceof VngApiError && err.status === 409) {
      logger.info({ label }, "drone-role: manny busy (409), deferring");
      return;
    }
    logger.error({ label, err: err?.message }, "drone-role: automation error");
    await updateDroneRoleState(role.id, { lastError: err?.message ?? String(err) });
  }
}

// ── Refuel Role ───────────────────────────────────────────────────────────────

async function runRefuelRole(
  role: DroneRole,
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  isMoving: boolean,
  label: string,
): Promise<void> {
  const cfg = role.config as RefuelConfig;
  const phase = role.state.phase;
  const threshold = cfg.minFuelThreshold ?? 80;

  if (phase === "idle") {
    // Fetch target probe's fuel level
    const c2 = clientFor(cfg.targetProbeId);
    let targetFuel = 100;
    try {
      const resp = await c2.getProbe();
      targetFuel = resp?.probe?.fuel?.deuterium ?? 100;
    } catch {
      logger.warn({ label }, "drone-role: could not fetch target probe state");
      return;
    }
    if (targetFuel < threshold) {
      logger.info({ label, targetFuel, threshold }, "drone-role: target needs fuel — heading to source");
      await updateDroneRoleState(role.id, { phase: "traveling_to_source" });
    } else {
      logger.info({ label, targetFuel }, "drone-role: target fuel OK — staying idle");
    }
    return;
  }

  if (phase === "traveling_to_source") {
    if (isMoving) return; // wait for arrival
    if (atSector(probe, cfg.sourceSector)) {
      logger.info({ label }, "drone-role: arrived at source — refilling");
      await updateDroneRoleState(role.id, { phase: "refilling" });
      return;
    }
    // Issue move
    logger.info({ label, target: cfg.sourceSector }, "drone-role: moving to source sector");
    try {
      await c.moveProbe(cfg.sourceSector.x, cfg.sourceSector.y, cfg.sourceSector.z);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: move to source failed");
    }
    return;
  }

  if (phase === "refilling") {
    // Check if our tank is at 100%
    const ourFuel = probe?.fuel?.deuterium ?? 0;
    if (ourFuel >= 99) {
      logger.info({ label }, "drone-role: tank full — heading to target");
      await updateDroneRoleState(role.id, { phase: "traveling_to_target" });
      return;
    }
    if (isMoving) return;
    // Find deuterium_refuel_station and send a Manny
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }
    const station = sectorObjects.find((o: any) => o.type === "deuterium_refuel_station");
    if (!station) {
      logger.warn({ label }, "drone-role: no deuterium_refuel_station in sector");
      return;
    }
    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny for refill");
      return;
    }
    logger.info({ label, mannyId: manny.id }, "drone-role: refilling deuterium tank");
    await c.refillDeuteriumTank(manny.id);
    claimed.add(manny.id);
    return;
  }

  if (phase === "traveling_to_target") {
    if (isMoving) return;
    // We need to be in the same sector as the target probe.
    // Fetch target probe's sector.
    const c2 = clientFor(cfg.targetProbeId);
    let targetSector: { x: number; y: number; z: number } | null = null;
    try {
      const resp = await c2.getProbe();
      targetSector = resp?.probe?.sector ?? null;
    } catch {
      logger.warn({ label }, "drone-role: could not fetch target probe sector");
      return;
    }
    if (!targetSector) {
      logger.warn({ label }, "drone-role: target probe has no sector — may be in transit");
      return;
    }
    if (atSector(probe, targetSector)) {
      logger.info({ label }, "drone-role: arrived at target — transferring deuterium");
      await updateDroneRoleState(role.id, { phase: "transferring" });
      return;
    }
    logger.info({ label, target: targetSector }, "drone-role: moving to target probe sector");
    try {
      await c.moveProbe(targetSector.x, targetSector.y, targetSector.z);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: move to target failed");
    }
    return;
  }

  if (phase === "transferring") {
    if (isMoving) return;
    const ourFuel = probe?.fuel?.deuterium ?? 0;
    const transferable = Math.floor(ourFuel) - MIN_DEUTERIUM_RESERVE;
    if (transferable <= 0) {
      logger.warn({ label, ourFuel }, "drone-role: not enough fuel to transfer — returning to idle");
      await updateDroneRoleState(role.id, { phase: "idle" });
      return;
    }
    // Find target probe as a sector object
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }
    const targetObj = sectorObjects.find(
      (o: any) => o.type === "probe" && o.probeId === cfg.targetProbeId,
    );
    if (!targetObj) {
      logger.warn({ label, targetProbeId: cfg.targetProbeId }, "drone-role: target probe not visible in sector — re-fetching target sector next tick");
      await updateDroneRoleState(role.id, { phase: "traveling_to_target" });
      return;
    }
    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny for deuterium transfer");
      return;
    }
    logger.info({ label, amount: transferable, mannyId: manny.id }, "drone-role: transferring deuterium");
    await c.transferDeuteriumToProbe(manny.id, cfg.targetProbeId, transferable);
    claimed.add(manny.id);
    await updateDroneRoleState(role.id, { phase: "idle" });
    return;
  }
}

// ── Delivery Role ─────────────────────────────────────────────────────────────

export async function runDeliveryRole(
  role: DroneRole,
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  isMoving: boolean,
  label: string,
): Promise<void> {
  const phase = role.state.phase;

  if (phase === "waiting") {
    // A delivery drone must have its supply loadout before it can accept a
    // dispatch: always a container, and — when a Factory Drone serves this
    // drone — the full supply loadout the factory is responsible for.
    const items: any[] = probe?.inventory?.items ?? [];
    const hasContainer = items.some(isContainerItem);
    const allRoles = await getDroneRoles().catch(() => [] as DroneRole[]);
    const myFactory = allRoles.find(
      (r) =>
        r.enabled &&
        r.roleType === "factory" &&
        ((r.config as FactoryConfig).deliveryProbeIds ?? []).includes(role.probeId),
    );
    if (myFactory && missingSupplies(probe).length > 0) {
      logger.info({ label }, "drone-role: loadout incomplete — waiting for factory supply run");
      // fall through only to attempt staged-container pickup below
    }
    if (!hasContainer) {
      if (isMoving) return;
      let sectorObjects: any[] = [];
      try {
        const resp = await c.getSector();
        sectorObjects = resp?.sector?.objects ?? [];
      } catch {
        return;
      }
      // Prefer the specific container our factory staged for us (if any).
      const stagedId = myFactory?.state.stagedContainerObjectId;
      const drifting =
        (stagedId != null
          ? sectorObjects.find((o: any) => o.id === stagedId)
          : undefined) ??
        sectorObjects.find(
          (o: any) => o.type === "storage_container" && o.mode === "drifting",
        );
      if (drifting) {
        const manny = pickIdleManny(mannies, claimed);
        if (manny) {
          logger.info({ label, objectId: drifting.id }, "drone-role: loading staged supply container");
          try {
            await c.recoverContainer(manny.id, drifting.id);
            claimed.add(manny.id);
          } catch (err: any) {
            logger.warn({ label, err: err?.message }, "drone-role: staged container recovery failed");
          }
        }
      } else {
        logger.info({ label }, "drone-role: no container loaded — waiting for factory to stage one");
      }
      return; // never accept a dispatch while empty
    }

    // Factory-served drones also wait for the full supply loadout.
    if (myFactory && missingSupplies(probe).length > 0) return;

    // Poll for a pending delivery request
    const request = await getPendingDeliveryRequest();
    if (!request) {
      // No requests — stay put
      return;
    }
    // Claim this request
    await updateDeliveryRequest(request.id, {
      status: "assigned",
      assignedDeliveryProbeId: role.probeId,
    });
    await updateDroneRoleState(role.id, {
      phase: "traveling_to_explorer",
      assignedExplorerId: request.explorerId,
      travelTarget: request.explorerSector,
    });
    logger.info({ label, requestId: request.id, explorerSector: request.explorerSector }, "drone-role: delivery dispatched");
    return;
  }

  if (phase === "traveling_to_explorer") {
    if (isMoving) return;
    const target = role.state.travelTarget;
    if (!target) {
      await updateDroneRoleState(role.id, { phase: "waiting" });
      return;
    }
    if (atSector(probe, target)) {
      logger.info({ label }, "drone-role: arrived at explorer — delivering");
      await updateDroneRoleState(role.id, { phase: "delivering" });
      return;
    }
    logger.info({ label, target }, "drone-role: moving to explorer sector");
    try {
      await c.moveProbe(target.x, target.y, target.z);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: move to explorer failed");
    }
    return;
  }

  if (phase === "delivering") {
    if (isMoving) return;
    // Find a container in inventory to detach for the explorer.
    // Also transfer deuterium if the explorer is present as a sector object.
    const items: any[] = probe?.inventory?.items ?? [];
    const container = items.find(isContainerItem);

    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }

    const explorerId = role.state.assignedExplorerId;

    // Transfer deuterium to explorer if present in sector
    if (explorerId != null) {
      const explorerObj = sectorObjects.find(
        (o: any) => o.type === "probe" && o.probeId === explorerId,
      );
      const ourFuel = probe?.fuel?.deuterium ?? 0;
      const transferable = Math.floor(ourFuel) - MIN_DEUTERIUM_RESERVE;
      if (explorerObj && transferable > 0) {
        const manny = pickIdleManny(mannies, claimed);
        if (manny) {
          logger.info({ label, amount: transferable }, "drone-role: transferring deuterium to explorer");
          try {
            await c.transferDeuteriumToProbe(manny.id, explorerId, transferable);
            claimed.add(manny.id);
          } catch (err: any) {
            logger.warn({ label, err: err?.message }, "drone-role: deuterium transfer failed");
          }
        }
      }
    }

    // Detach a container (drift it in sector for the explorer to recover)
    if (container) {
      const manny = pickIdleManny(mannies, claimed);
      if (manny) {
        logger.info({ label, containerId: container.id }, "drone-role: detaching delivery container");
        try {
          await c.detachContainer(manny.id, container.id, "drifting");
          claimed.add(manny.id);
        } catch (err: any) {
          logger.warn({ label, err: err?.message }, "drone-role: detach container failed");
        }
      }
    }

    // Collect any drifting container left by the explorer (previous empty)
    const drifting = sectorObjects.find(
      (o: any) => o.type === "storage_container" && o.mode === "drifting",
    );
    if (drifting) {
      const manny = pickIdleManny(mannies, claimed);
      if (manny) {
        logger.info({ label, objectId: drifting.id }, "drone-role: collecting explorer's empty container");
        try {
          await c.recoverContainer(manny.id, drifting.id);
          claimed.add(manny.id);
        } catch (err: any) {
          logger.warn({ label, err: err?.message }, "drone-role: container recovery failed");
        }
      }
    }

    // Mark the delivery request completed
    const requests = await getDeliveryRequests();
    const req = requests.find(
      (r) =>
        r.status === "assigned" &&
        r.assignedDeliveryProbeId === role.probeId,
    );
    if (req) {
      await updateDeliveryRequest(req.id, { status: "completed" });
    }

    await updateDroneRoleState(role.id, {
      phase: "returning",
      assignedExplorerId: undefined,
      travelTarget: undefined,
    });
    return;
  }

  if (phase === "returning") {
    // Return to factory probe's sector
    const cfg = role.config as DeliveryConfig;
    if (isMoving) return;

    let factorySector: { x: number; y: number; z: number } | null = null;
    try {
      const resp = await clientFor(cfg.factoryProbeId).getProbe();
      factorySector = resp?.probe?.sector ?? null;
    } catch {
      logger.warn({ label }, "drone-role: could not fetch factory sector");
      return;
    }
    if (!factorySector) return;

    if (atSector(probe, factorySector)) {
      logger.info({ label }, "drone-role: returned to factory — waiting for next dispatch");
      await updateDroneRoleState(role.id, { phase: "waiting" });
      return;
    }
    logger.info({ label, target: factorySector }, "drone-role: returning to factory");
    try {
      await c.moveProbe(factorySector.x, factorySector.y, factorySector.z);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: return move failed");
    }
    return;
  }
}

// ── Explorer Role ─────────────────────────────────────────────────────────────

async function runExplorerRole(
  role: DroneRole,
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  isMoving: boolean,
  label: string,
): Promise<void> {
  const cfg = role.config as ExplorerConfig;
  const phase = role.state.phase;
  const currentSector = probe?.sector ?? null;

  if (phase === "idle") {
    if (!currentSector) return;
    if (reachedTarget(currentSector, cfg.targetVector)) {
      logger.info({ label }, "drone-role: explorer reached target vector — staying idle");
      return;
    }
    const next = nextSectorToward(currentSector, cfg.targetVector);
    logger.info({ label, next }, "drone-role: explorer moving to next sector");
    try {
      await c.moveProbe(next.x, next.y, next.z);
      await updateDroneRoleState(role.id, {
        phase: "traveling",
        travelTarget: next,
      });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: explorer move failed");
    }
    return;
  }

  if (phase === "traveling") {
    if (isMoving) return; // in flight, only repair (already done above)
    // Arrived at new sector
    const target = role.state.travelTarget;
    if (target && currentSector && sectorKey(currentSector) === sectorKey(target)) {
      logger.info({ label, sector: currentSector }, "drone-role: explorer arrived — scanning for relay");
      await updateDroneRoleState(role.id, { phase: "deploying_relay" });
    } else if (!isMoving && currentSector) {
      // Not at expected target — update phase anyway
      await updateDroneRoleState(role.id, { phase: "deploying_relay" });
    }
    return;
  }

  if (phase === "deploying_relay") {
    if (isMoving) return;
    // Scan sector for an inactive SCUT relay
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }

    const inactiveRelay = sectorObjects.find(
      (o: any) => o.type === "scut_relay" && o.active === false,
    );

    if (inactiveRelay) {
      logger.info({ label, relayId: inactiveRelay.id }, "drone-role: inactive relay found — activating");
      await updateDroneRoleState(role.id, { phase: "activating_relay" });
      return;
    }

    // Check if there's already an active relay (already set up)
    const activeRelay = sectorObjects.find(
      (o: any) => o.type === "scut_relay" && o.active === true,
    );
    if (activeRelay) {
      logger.info({ label }, "drone-role: relay already active — installing beacon");
      await updateDroneRoleState(role.id, { phase: "installing_beacon" });
      return;
    }

    // No relay found — check inventory for scut_relay item to craft/deploy.
    // A manny can craft one, then it becomes a sector object via drop.
    // For now we log a warning and wait — manual placement or future automation.
    const items: any[] = probe?.inventory?.items ?? [];
    const hasRelay = items.some((i: any) => i.type === "scut_relay");
    if (hasRelay) {
      // A manny can install a relay from inventory by dropping it.
      // Use dropMannyCargo approach: craft first puts in manny cargo.
      // For now, we need a manny to carry and drop the item. This requires
      // further VNG API exploration. Log and wait for next tick.
      logger.info({ label }, "drone-role: scut_relay in inventory — awaiting relay object in sector (manual drop or future API)");
    } else {
      logger.info({ label }, "drone-role: no relay in sector or inventory — need to craft one");
    }
    return;
  }

  if (phase === "activating_relay") {
    if (isMoving) return;
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }

    const inactiveRelay = sectorObjects.find(
      (o: any) => o.type === "scut_relay" && o.active === false,
    );
    if (!inactiveRelay) {
      // Check if it became active already
      const activeRelay = sectorObjects.find(
        (o: any) => o.type === "scut_relay" && o.active === true,
      );
      if (activeRelay) {
        await updateDroneRoleState(role.id, { phase: "installing_beacon" });
      }
      return;
    }

    // Need integrated_circuit in inventory
    const items: any[] = probe?.inventory?.items ?? [];
    const hasIC = items.some((i: any) => i.type === "integrated_circuit");
    if (!hasIC) {
      logger.warn({ label }, "drone-role: no integrated_circuit to activate relay — waiting");
      return;
    }

    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny for relay activation");
      return;
    }

    const relayId = parseInt(inactiveRelay.id, 10);
    logger.info({ label, relayId, mannyId: manny.id }, "drone-role: activating SCUT relay");
    try {
      await c.turnOnRelay(manny.id, relayId, cfg.scutNetworkName);
      claimed.add(manny.id);
      await updateDroneRoleState(role.id, { phase: "installing_beacon" });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: relay activation failed");
    }
    return;
  }

  if (phase === "installing_beacon") {
    if (isMoving) return;
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }

    const relay = sectorObjects.find((o: any) => o.type === "scut_relay");
    if (!relay) {
      logger.warn({ label }, "drone-role: no relay in sector for beacon installation");
      await updateDroneRoleState(role.id, { phase: "deploying_relay" });
      return;
    }

    const items: any[] = probe?.inventory?.items ?? [];
    const hasBookmark = items.some((i: any) => i.type === "waypoint_bookmark");
    if (!hasBookmark) {
      logger.warn({ label }, "drone-role: no waypoint_bookmark — skipping beacon, dropping container");
      await updateDroneRoleState(role.id, { phase: "dropping_container" });
      return;
    }

    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny for beacon installation");
      return;
    }

    const sectorKey2 = currentSector
      ? `${currentSector.x}.${currentSector.y}.${currentSector.z}`
      : "unknown";
    const beaconName = `SCUT-${sectorKey2}`;
    logger.info({ label, objectId: relay.id, name: beaconName }, "drone-role: installing waypoint beacon");
    try {
      await c.installWaypointBookmark(manny.id, relay.id, beaconName);
      claimed.add(manny.id);
      await updateDroneRoleState(role.id, { phase: "dropping_container" });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: beacon installation failed");
    }
    return;
  }

  if (phase === "dropping_container") {
    if (isMoving) return;
    const items: any[] = probe?.inventory?.items ?? [];
    const container = items.find(isContainerItem);
    if (!container) {
      logger.info({ label }, "drone-role: no container to drop — signaling delivery anyway");
      await updateDroneRoleState(role.id, { phase: "waiting_for_delivery" });
      return;
    }

    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny for container drop");
      return;
    }

    logger.info({ label, containerId: container.id }, "drone-role: dropping container in sector");
    try {
      await c.detachContainer(manny.id, container.id, "drifting");
      claimed.add(manny.id);
      await updateDroneRoleState(role.id, { phase: "waiting_for_delivery" });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: drop container failed");
    }
    return;
  }

  if (phase === "waiting_for_delivery") {
    // Signal that we need a delivery if we haven't already
    const existingReqId = role.state.deliveryRequestId;
    if (existingReqId == null && currentSector) {
      const req = await addDeliveryRequest({
        explorerId: role.probeId,
        explorerName: role.probeName,
        explorerSector: currentSector,
      });
      await updateDroneRoleState(role.id, { deliveryRequestId: req.id });
      logger.info({ label, requestId: req.id, sector: currentSector }, "drone-role: delivery request created");
      return;
    }

    // Check if the delivery request has been completed
    if (existingReqId != null) {
      const requests = await getDeliveryRequests();
      const req = requests.find((r) => r.id === existingReqId);
      if (req?.status === "completed") {
        logger.info({ label }, "drone-role: delivery received — resuming exploration");
        await updateDroneRoleState(role.id, {
          phase: "idle",
          deliveryRequestId: undefined,
          lastDeployedSector: currentSector ?? undefined,
        });
      } else {
        logger.info({ label, requestId: existingReqId }, "drone-role: waiting for delivery");
      }
    }
    return;
  }
}

// ── Factory Role ──────────────────────────────────────────────────────────────
//
// The VNG API has no operation that moves crafted items into a storage
// container (probed: no store/load/move-item endpoints exist). The only way
// supplies physically travel with a Delivery Drone is to exist in *its*
// probe inventory. So the factory coordinates the supply run remotely:
// it crafts each missing supply item directly aboard the docked Delivery
// Drone using that drone's own Mannies/printer, and — when the drone lacks a
// container the factory can't craft aboard it — stages one of its own
// containers (drifting) for the drone to recover.

/** Supply loadout a Delivery Drone ships with (1 of each). `printer: true`
 *  items are printer-only and must be built with the Atomic Printer. */
export const FACTORY_SUPPLY_ITEMS: { type: string; recipe: string; printer?: boolean }[] = [
  { type: "scut_relay", recipe: "scut_relay" },
  { type: "integrated_circuit", recipe: "integrated_circuit", printer: true },
  { type: "waypoint_bookmark", recipe: "waypoint_bookmark" }, // transit beacon
];

export type FactoryDeps = {
  getDroneRoles: typeof getDroneRoles;
  updateDroneRoleState: typeof updateDroneRoleState;
  clientFor: typeof clientFor;
};

const defaultFactoryDeps: FactoryDeps = { getDroneRoles, updateDroneRoleState, clientFor };

/** What the delivery drone is still missing for a full supply loadout. */
export function missingSupplies(dProbe: any): { type: string; recipe: string; printer?: boolean }[] {
  const items: any[] = dProbe?.inventory?.items ?? [];
  const missing = FACTORY_SUPPLY_ITEMS.filter(
    (s) => !items.some((i: any) => i.type === s.type),
  );
  if (!items.some(isContainerItem)) {
    return [{ type: "additional_container", recipe: "additional_container" }, ...missing];
  }
  return missing;
}

export async function runFactoryRole(
  role: DroneRole,
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  isMoving: boolean,
  label: string,
  deps: FactoryDeps = defaultFactoryDeps,
): Promise<void> {
  const cfg = role.config as FactoryConfig;
  const phase = role.state.phase;
  const servedIds = cfg.deliveryProbeIds ?? [];

  if (phase === "idle") {
    if (servedIds.length === 0) {
      logger.info({ label }, "drone-role: factory has no delivery drones configured");
      return;
    }
    // Find a served Delivery Drone that is docked here (same sector, waiting)
    // and is missing part of its supply loadout.
    const allRoles = await deps.getDroneRoles();
    for (const deliveryId of servedIds) {
      const dRole = allRoles.find(
        (r) => r.probeId === deliveryId && r.enabled && r.roleType === "delivery",
      );
      if (!dRole || dRole.state.phase !== "waiting") continue;

      let dProbe: any = null;
      try {
        const resp = await deps.clientFor(deliveryId).getProbe();
        dProbe = resp?.probe ?? null;
      } catch {
        logger.warn({ label, deliveryId }, "drone-role: could not fetch delivery drone state");
        continue;
      }
      if (!dProbe?.sector || !atSector(probe, dProbe.sector)) continue; // not docked here

      if (missingSupplies(dProbe).length === 0) continue; // fully loaded

      logger.info({ label, deliveryId }, "drone-role: delivery drone docked under-supplied — starting supply run");
      await deps.updateDroneRoleState(role.id, {
        phase: "supplying",
        servingDeliveryProbeId: deliveryId,
      });
      return;
    }
    return;
  }

  if (phase === "supplying") {
    const deliveryId = role.state.servingDeliveryProbeId;
    if (deliveryId == null) {
      await deps.updateDroneRoleState(role.id, { phase: "idle" });
      return;
    }

    // Revalidate the target: it must still hold the delivery role, be in
    // its waiting phase, and be docked in our sector. Otherwise abandon.
    const allRoles = await deps.getDroneRoles();
    const dRole = allRoles.find(
      (r) => r.probeId === deliveryId && r.enabled && r.roleType === "delivery",
    );
    if (!dRole || dRole.state.phase !== "waiting") {
      logger.info({ label, deliveryId }, "drone-role: delivery drone no longer waiting — abandoning supply run");
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        servingDeliveryProbeId: undefined,
        stagedContainerObjectId: undefined,
      });
      return;
    }

    const dc = deps.clientFor(deliveryId);
    let dProbe: any = null;
    try {
      const resp = await dc.getProbe();
      dProbe = resp?.probe ?? null;
    } catch {
      logger.warn({ label, deliveryId }, "drone-role: could not fetch delivery drone during supply run");
      return;
    }
    if (!dProbe?.sector || !atSector(probe, dProbe.sector)) {
      logger.info({ label, deliveryId }, "drone-role: delivery drone left the sector — abandoning supply run");
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        servingDeliveryProbeId: undefined,
        stagedContainerObjectId: undefined,
      });
      return;
    }

    const missing = missingSupplies(dProbe);
    if (missing.length === 0) {
      logger.info({ label, deliveryId }, "drone-role: delivery drone fully supplied");
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        servingDeliveryProbeId: undefined,
      });
      return;
    }

    const next = missing[0];

    // Container shortfall: craft one aboard the drone; if that fails and the
    // factory has a spare, stage it (drifting) for the drone to recover.
    if (next.type === "additional_container") {
      const staged = await craftAboardDelivery(dc, deliveryId, next, label, dProbe);
      if (!staged) {
        const spare = (probe?.inventory?.items ?? []).find(isContainerItem);
        if (spare) {
          const manny = pickIdleManny(mannies, claimed);
          if (!manny) {
            logger.info({ label }, "drone-role: no idle manny to stage spare container");
            return;
          }
          logger.info({ label, containerId: spare.id }, "drone-role: staging spare container for delivery drone");
          try {
            await c.detachContainer(manny.id, spare.id, "drifting");
            claimed.add(manny.id);
            const { toSectorObjectId } = await import("./file-store.js");
            await deps.updateDroneRoleState(role.id, {
              phase: "handoff",
              stagedContainerObjectId: toSectorObjectId(spare.id),
            });
          } catch (err: any) {
            logger.warn({ label, err: err?.message }, "drone-role: container staging failed");
          }
        }
      }
      return;
    }

    // Regular supply item: craft it aboard the delivery drone (one per tick).
    await craftAboardDelivery(dc, deliveryId, next, label, dProbe);
    return;
  }

  if (phase === "handoff") {
    // Wait until the served delivery drone has recovered the staged container.
    const deliveryId = role.state.servingDeliveryProbeId;
    if (deliveryId == null) {
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        stagedContainerObjectId: undefined,
      });
      return;
    }

    // Same revalidation as `supplying`: abandon if the drone is no longer an
    // enabled, waiting delivery drone (the staged container stays drifting
    // and will be found by the next waiting drone / supply run).
    const allRoles = await deps.getDroneRoles();
    const dRole = allRoles.find(
      (r) => r.probeId === deliveryId && r.enabled && r.roleType === "delivery",
    );
    if (!dRole || dRole.state.phase !== "waiting") {
      logger.info({ label, deliveryId }, "drone-role: delivery drone no longer waiting — abandoning handoff");
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        servingDeliveryProbeId: undefined,
        stagedContainerObjectId: undefined,
      });
      return;
    }

    let dProbe: any = null;
    try {
      const resp = await deps.clientFor(deliveryId).getProbe();
      dProbe = resp?.probe ?? null;
    } catch {
      logger.warn({ label, deliveryId }, "drone-role: could not fetch delivery drone during handoff");
      return;
    }
    if (!dProbe?.sector || !atSector(probe, dProbe.sector)) {
      logger.info({ label, deliveryId }, "drone-role: delivery drone left the sector — abandoning handoff");
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        servingDeliveryProbeId: undefined,
        stagedContainerObjectId: undefined,
      });
      return;
    }
    const dHasContainer = (dProbe?.inventory?.items ?? []).some(isContainerItem);
    if (dHasContainer) {
      logger.info({ label, deliveryId }, "drone-role: container handoff complete — resuming supply run");
      await deps.updateDroneRoleState(role.id, {
        phase: "supplying",
        stagedContainerObjectId: undefined,
      });
    } else {
      logger.info({ label, deliveryId }, "drone-role: waiting for delivery drone to recover staged container");
    }
    return;
  }
}

/** Craft one supply item aboard the delivery drone using its own Mannies or
 *  printer. Returns true when a craft was successfully started. */
async function craftAboardDelivery(
  dc: ReturnType<typeof clientFor>,
  deliveryId: number,
  supply: { type: string; recipe: string; printer?: boolean },
  label: string,
  dProbe?: any,
): Promise<boolean> {
  try {
    if (supply.printer) {
      // Idempotency: the printer runs one job at a time — if it is already
      // busy, the previous print is still in flight; wait, don't re-issue.
      const printer = (dProbe?.inventory?.items ?? []).find(
        (i: any) => i.type === "atomic_3d_printer",
      );
      if (printer?.currentTask) {
        logger.info({ label, deliveryId }, "drone-role: printer busy aboard delivery drone — waiting");
        return false;
      }
      logger.info({ label, deliveryId, recipe: supply.recipe }, "drone-role: printing supply item aboard delivery drone");
      await dc.atomicPrinterCraft(supply.recipe);
      return true;
    }
    let dMannies: any[] = [];
    try {
      const resp = await dc.getMannies();
      dMannies = resp?.mannies ?? [];
    } catch {
      return false;
    }
    // Idempotency: crafts are long-running and the item only appears in
    // inventory on completion. If ANY manny aboard the delivery drone is
    // already busy, assume our previous supply craft is still in flight and
    // wait — never hand the same recipe to a second idle manny.
    if (dMannies.some((m: any) => m.currentTask)) {
      logger.info({ label, deliveryId }, "drone-role: craft already in progress aboard delivery drone — waiting");
      return false;
    }
    const manny = pickIdleManny(dMannies, new Set());
    if (!manny) {
      logger.info({ label, deliveryId }, "drone-role: no idle manny aboard delivery drone");
      return false;
    }
    logger.info({ label, deliveryId, recipe: supply.recipe, mannyId: manny.id }, "drone-role: crafting supply item aboard delivery drone");
    await dc.craftItem(manny.id, supply.recipe);
    return true;
  } catch (err: any) {
    logger.warn({ label, deliveryId, recipe: supply.recipe, err: err?.message }, "drone-role: supply craft failed");
    return false;
  }
}
