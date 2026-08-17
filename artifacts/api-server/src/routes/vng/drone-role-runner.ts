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

async function runDeliveryRole(
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
    const container = items.find(
      (i: any) => i.type === "storage_container" || i.category === "container",
    );

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
    const container = items.find(
      (i: any) => i.type === "storage_container" || i.category === "container",
    );
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
// Keeps one fully-stocked container staged (drifting) in sector at all times.
// Delivery Drones recover it on dispatch; when it disappears the factory
// crafts the next load and stages a fresh container.
//
// Default stock: scut_relay × 1, integrated_circuit × 1, waypoint_bookmark × 1
// These supply an Explorer for one hop.

const DEFAULT_STOCK: Array<{ recipe: string; quantity: number }> = [
  { recipe: "scut_relay",         quantity: 1 },
  { recipe: "integrated_circuit", quantity: 1 },
  { recipe: "waypoint_bookmark",  quantity: 1 },
];

async function runFactoryRole(
  role: DroneRole,
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  isMoving: boolean,
  label: string,
): Promise<void> {
  if (isMoving) return; // factory stays put

  const cfg = role.config as FactoryConfig;
  const stock = cfg.stockItems?.length ? cfg.stockItems : DEFAULT_STOCK;
  const phase = role.state.phase;
  const items: any[] = probe?.inventory?.items ?? [];

  // ── idle ──────────────────────────────────────────────────────────────────
  if (phase === "idle") {
    // Scan sector for our previously staged (drifting) container.
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch {
      return;
    }

    const stagedId = role.state.stagedContainerId;
    if (stagedId) {
      const stillThere = sectorObjects.some(
        (o: any) => o.id === stagedId && o.mode === "drifting",
      );
      if (stillThere) {
        logger.info({ label, containerId: stagedId }, "drone-role: factory — staged container waiting for pickup");
        return;
      }
      // Container was picked up — start next load cycle
      logger.info({ label }, "drone-role: factory — container picked up, starting next cycle");
      await updateDroneRoleState(role.id, { stagedContainerId: undefined, phase: "crafting" });
      return;
    }

    // No staged container on record — check if one is already drifting (e.g. leftover)
    const anyDrifting = sectorObjects.find(
      (o: any) =>
        (o.type === "storage_container" || o.category === "container") &&
        o.mode === "drifting",
    );
    if (anyDrifting) {
      logger.info({ label, containerId: anyDrifting.id }, "drone-role: factory — drifting container found, adopting");
      await updateDroneRoleState(role.id, { stagedContainerId: anyDrifting.id });
      return;
    }

    // Nothing staged — determine if stock is ready
    const missingItems = getMissingStock(items, stock);
    if (missingItems.length === 0) {
      await updateDroneRoleState(role.id, { phase: "staging" });
    } else {
      await updateDroneRoleState(role.id, { phase: "crafting" });
    }
    return;
  }

  // ── crafting ──────────────────────────────────────────────────────────────
  if (phase === "crafting") {
    const missing = getMissingStock(items, stock);
    if (missing.length === 0) {
      logger.info({ label }, "drone-role: factory — stock complete, staging container");
      await updateDroneRoleState(role.id, { phase: "staging" });
      return;
    }

    // Craft one missing item this tick
    const { recipe, needed } = missing[0];
    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: factory — no idle manny for crafting");
      return;
    }

    logger.info({ label, recipe, needed, mannyId: manny.id }, "drone-role: factory — crafting stock item");
    try {
      await c.craftItem(manny.id, recipe);
      claimed.add(manny.id);
    } catch (err: any) {
      if (err instanceof VngApiError && err.status === 409) {
        // Manny busy — defer
      } else {
        logger.warn({ label, recipe, err: err?.message }, "drone-role: factory — craft failed");
      }
    }
    return;
  }

  // ── staging ───────────────────────────────────────────────────────────────
  if (phase === "staging") {
    // Find a container in inventory to detach
    const container = items.find(
      (i: any) => i.type === "storage_container" || i.category === "container",
    );
    if (!container) {
      logger.warn({ label }, "drone-role: factory — no container in inventory to stage");
      // Check if there is one in sector we can recover first
      let sectorObjects: any[] = [];
      try {
        const resp = await c.getSector();
        sectorObjects = resp?.sector?.objects ?? [];
      } catch {
        return;
      }
      const loose = sectorObjects.find(
        (o: any) =>
          (o.type === "storage_container" || o.category === "container") &&
          o.mode !== "drifting",
      );
      if (loose) {
        const manny = pickIdleManny(mannies, claimed);
        if (manny) {
          logger.info({ label, objectId: loose.id }, "drone-role: factory — recovering container from sector");
          try {
            await c.recoverContainer(manny.id, loose.id);
            claimed.add(manny.id);
          } catch (err: any) {
            logger.warn({ label, err: err?.message }, "drone-role: factory — container recovery failed");
          }
        }
      }
      return;
    }

    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: factory — no idle manny for staging");
      return;
    }

    logger.info({ label, containerId: container.id, mannyId: manny.id }, "drone-role: factory — detaching container as staged supply");
    try {
      await c.detachContainer(manny.id, container.id, "drifting");
      claimed.add(manny.id);
      await updateDroneRoleState(role.id, {
        phase: "idle",
        stagedContainerId: container.id,
      });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: factory — detach container failed");
    }
    return;
  }
}

/** Returns list of stock items not yet present in inventory (with how many are missing). */
function getMissingStock(
  inventoryItems: any[],
  stock: Array<{ recipe: string; quantity: number }>,
): Array<{ recipe: string; needed: number }> {
  const countByType = new Map<string, number>();
  for (const item of inventoryItems) {
    const t: string = item.type ?? item.recipe ?? "";
    countByType.set(t, (countByType.get(t) ?? 0) + 1);
  }
  const result: Array<{ recipe: string; needed: number }> = [];
  for (const { recipe, quantity } of stock) {
    const have = countByType.get(recipe) ?? 0;
    if (have < quantity) result.push({ recipe, needed: quantity - have });
  }
  return result;
}
