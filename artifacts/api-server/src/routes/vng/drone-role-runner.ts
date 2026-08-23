/**
 * Drone Role Automation Runner
 *
 * Called once per probe per poll tick.  Each role type has its own state
 * machine; state is persisted between ticks via drone-roles-store.
 *
 * Repair in transit: every drone repairs damaged probe hulls at the start of
 * every tick, regardless of travel status.
 */

import { logger } from "../../lib/logger.js";
import { clientFor, VngApiError, getScutNetwork } from "./client.js";
import { getSectors, recordExplorerWaypointEvent } from "./file-store.js";
import { mapSectorObjects } from "./sector-map.js";
import {
  getDroneRoleByProbeId,
  getDroneRoles,
  updateDroneRoleState,
  claimRefuelTarget,
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
/** An idle refueler returns to its source at or below this share of its own tank. */
const REFUELER_RETURN_THRESHOLD_PERCENT = 20;

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

/** SCUT relay sector objects report state as `status: "off" | "on"` (per the
 *  VNG OpenAPI spec); older code assumed a boolean `active`. Accept both. */
export function isInactiveRelay(o: any): boolean {
  return (
    o?.type === "scut_relay" && (o.status === "off" || o.active === false)
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
  // VNG API returns coordinates at probe.sector.relative, not probe.sector directly.
  const s = probe?.sector?.relative;
  return s != null && s.x === target.x && s.y === target.y && s.z === target.z;
}

/**
 * Compute the next sector one hop toward `target` from `current`.
 *
 * VNG sectors only exist where x + y + z is even.  Stepping on all three axes
 * simultaneously changes the sum by an odd amount (always invalid).  To keep
 * parity we must step on EXACTLY TWO axes per hop — net ±2 or 0 change in sum.
 *
 * Strategy: sort axes by |remaining delta| descending, step the two largest.
 * When only one axis has nonzero delta the other step is a "detour" (+1 on a
 * neutral axis) that the following tick automatically corrects.  Because the
 * target's sum and the current sum are both even, the total remaining delta sum
 * is always even, guaranteeing convergence.
 */
function nextSectorToward(
  current: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const deltas: Array<{ key: "x" | "y" | "z"; delta: number }> = [
    { key: "x", delta: target.x - current.x },
    { key: "y", delta: target.y - current.y },
    { key: "z", delta: target.z - current.z },
  ];

  if (deltas.every((d) => d.delta === 0)) return { ...current };

  // Sort descending by absolute delta so we advance the axes that need it most.
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const result = { ...current };

  // Step the two highest-delta axes.
  const s0 = Math.sign(deltas[0].delta) || 1;          // primary step
  const s1 = Math.sign(deltas[1].delta) || (s0 > 0 ? 1 : -1); // detour if delta=0

  result[deltas[0].key] += s0;
  result[deltas[1].key] += s1;

  return result;
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

/** Chebyshev distance between two sectors (= minimum hops needed). */
function chebyshevDist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

/**
 * Delivery-drone waypoint router.
 *
 * Rules:
 *  1. If the destination is within 2 sectors (Chebyshev ≤ 2), go there directly.
 *  2. Otherwise find the active SCUT relay that makes the most progress toward
 *     the destination and jump to its sector (relay-to-relay long hop).
 *  3. If no relay helps, fall back to a single short hop via nextSectorToward.
 *
 * This keeps delivery drones either within short communication range OR hopping
 * through the SCUT network — never making uncovered long-range jumps.
 */
async function nextDeliveryWaypoint(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  label: string,
): Promise<{ x: number; y: number; z: number }> {
  // Within short range — go directly.
  if (chebyshevDist(from, to) <= 2) return to;

  // Collect known SCUT network IDs from cached sector data.
  const sectors = await getSectors();
  const networkIds = new Set<number>();
  for (const s of sectors) {
    for (const obj of (s as any).objects ?? []) {
      if (obj?.type === "scut_relay" && obj?.network?.id) {
        const networkId = Number(obj.network.id);
        if (Number.isInteger(networkId)) networkIds.add(networkId);
      }
    }
  }

  const totalDist = chebyshevDist(from, to);
  let bestSector: { x: number; y: number; z: number } | null = null;
  let bestProgress = 0; // must beat 0 — relay must bring us closer

  for (const netId of Array.from(networkIds)) {
    let net: any;
    try { net = await getScutNetwork(netId); } catch { continue; }
    for (const relay of net?.relays ?? []) {
      if (relay.status !== "on") continue;
      const rs = relay.sector?.relative;
      if (!rs) continue;
      const progress = totalDist - chebyshevDist(rs, to);
      if (progress > bestProgress) {
        bestProgress = progress;
        bestSector = { x: rs.x, y: rs.y, z: rs.z };
      }
    }
  }

  if (bestSector) {
    logger.info({ label, waypoint: bestSector, progress: bestProgress },
      "drone-role: delivery — routing via SCUT relay");
    return bestSector;
  }

  // No relay on path — take one short hop only.
  logger.info({ label }, "drone-role: delivery — no SCUT relay on path, short-hopping");
  return nextSectorToward(from, to);
}

/** Use up to one idle Manny per tick to repair the probe hull (works in transit). */
async function repairDamagedProbe(
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  label: string,
): Promise<void> {
  const integrity = Number(probe?.systems?.integrityPercent);
  if (!Number.isFinite(integrity) || integrity >= 99) return;

  const manny = pickIdleManny(mannies, claimed);
  if (!manny) return;

  const metalsAvailable = (probe?.inventory?.resourceStocks ?? [])
    .filter((stock: any) => String(stock?.type ?? "").toLowerCase() === "metals")
    .reduce((total: number, stock: any) => {
      const amount = Number(stock?.amount);
      return Number.isFinite(amount) && amount > 0 ? total + amount : total;
    }, 0);
  const missingIntegrity = Math.max(0, 100 - integrity);
  const metalsPerIntegrityPoint = 0.01;
  const affordableIntegrity = Math.floor(
    (metalsAvailable / metalsPerIntegrityPoint + Number.EPSILON) * 100,
  ) / 100;
  const integrityToRestore = Math.min(missingIntegrity, affordableIntegrity);

  if (integrityToRestore <= 0) {
    logger.info(
      { label, mannyId: manny.id, integrity, metalsAvailable },
      "drone-role: probe repair waiting for metals",
    );
    return;
  }

  try {
    await c.repairManny(manny.id, integrityToRestore);
    claimed.add(manny.id);
    logger.info(
      {
        label,
        mannyId: manny.id,
        integrity,
        metalsAvailable,
        integrityToRestore,
        metalsRequired: integrityToRestore * metalsPerIntegrityPoint,
      },
      "drone-role: repairing probe hull with Manny",
    );
  } catch (err: any) {
    if (!(err instanceof VngApiError && err.status === 409)) {
      logger.warn({ label, err: err?.message }, "drone-role: probe repair failed");
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
  await repairDamagedProbe(probe, mannies, claimed, c, label);

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

export type RefuelDeps = {
  updateDroneRoleState: typeof updateDroneRoleState;
  /** Return a probe-scoped client for the given probe ID (used to query the target). */
  clientFor: typeof clientFor;
  getDroneRoles: typeof getDroneRoles;
  claimRefuelTarget: typeof claimRefuelTarget;
};

const defaultRefuelDeps: RefuelDeps = {
  updateDroneRoleState,
  clientFor,
  getDroneRoles,
  claimRefuelTarget,
};

function fuelCapacity(probe: any): number {
  const max = Number(probe?.fuel?.maxDeuterium);
  return Number.isFinite(max) && max > 0 ? max : 100;
}

function fuelPercent(probe: any): number {
  return ((Number(probe?.fuel?.deuterium) || 0) / fuelCapacity(probe)) * 100;
}

function refuelerNeedsSourceTrip(probe: any): boolean {
  return fuelPercent(probe) <= REFUELER_RETURN_THRESHOLD_PERCENT;
}

function refuelerTankIsFull(probe: any): boolean {
  return (Number(probe?.fuel?.deuterium) || 0) >= fuelCapacity(probe);
}

const REFUEL_SERVICE_ROLE_TYPES = new Set<DroneRole["roleType"]>([
  "explorer",
  "delivery",
  "factory",
]);

type RefuelServiceTarget = {
  probeId: number;
  probeName?: string;
  fuel: number;
  capacity: number;
  fuelPercent: number;
};

async function getRefuelServiceTargets(
  serviceSector: { x: number; y: number; z: number },
  threshold: number,
  refuelRoleId: number,
  deps: RefuelDeps,
): Promise<RefuelServiceTarget[]> {
  const roles = await deps.getDroneRoles().catch(() => [] as DroneRole[]);
  const claimedTargetIds = new Set(
    roles
      .filter(
        (r) =>
          r.id !== refuelRoleId &&
          r.enabled &&
          r.roleType === "refuel" &&
          r.state.servingTargetProbeId != null,
      )
      .map((r) => r.state.servingTargetProbeId as number),
  );
  const candidates = roles.filter(
    (r) =>
      r.enabled &&
      REFUEL_SERVICE_ROLE_TYPES.has(r.roleType) &&
      !claimedTargetIds.has(r.probeId),
  );

  const targets = await Promise.all(
    candidates.map(async (candidate): Promise<RefuelServiceTarget | null> => {
      try {
        const response = await deps.clientFor(candidate.probeId).getProbe();
        const targetProbe = response?.probe;
        const fuel = Number(targetProbe?.fuel?.deuterium) || 0;
        const targetFuelPercent = fuelPercent(targetProbe);
        if (!atSector(targetProbe, serviceSector) || targetFuelPercent >= threshold) return null;
        return {
          probeId: candidate.probeId,
          probeName: candidate.probeName ?? targetProbe?.name,
          fuel,
          capacity: fuelCapacity(targetProbe),
          fuelPercent: targetFuelPercent,
        };
      } catch {
        return null;
      }
    }),
  );

  return targets
    .filter((target): target is RefuelServiceTarget => target != null)
    .sort((a, b) => a.fuelPercent - b.fuelPercent);
}

export async function runRefuelRole(
  role: DroneRole,
  probe: any,
  mannies: any[],
  claimed: Set<string>,
  c: ReturnType<typeof clientFor>,
  isMoving: boolean,
  label: string,
  deps: RefuelDeps = defaultRefuelDeps,
): Promise<void> {
  const cfg = role.config as RefuelConfig;
  const phase = role.state.phase;
  const threshold = cfg.minFuelThreshold ?? 80;

  if (phase === "idle") {
    // A refueler's own reserve is independent of the target's dispatch
    // threshold. Refill at 20% or lower, even while the target is healthy.
    const ourFuel = probe?.fuel?.deuterium ?? 0;
    const ourFuelPercent = fuelPercent(probe);
    if (refuelerNeedsSourceTrip(probe)) {
      if (atSector(probe, cfg.sourceSector)) {
        logger.info(
          { label, ourFuel, ourFuelPercent, threshold: REFUELER_RETURN_THRESHOLD_PERCENT },
          "drone-role: refueler fuel at or below return threshold — refilling at source",
        );
        await deps.updateDroneRoleState(role.id, { phase: "refilling" });
      } else {
        logger.info(
          { label, ourFuel, ourFuelPercent, threshold: REFUELER_RETURN_THRESHOLD_PERCENT },
          "drone-role: refueler fuel at or below return threshold — heading to source",
        );
        await deps.updateDroneRoleState(role.id, { phase: "traveling_to_source" });
      }
      return;
    }

    // The configured target is a destination-sector anchor. Service every
    // eligible role-assigned drone that is co-located with it, not just the
    // anchor probe itself.
    const c2 = deps.clientFor(cfg.targetProbeId);
    let anchorProbe: any;
    try {
      const resp = await c2.getProbe();
      anchorProbe = resp?.probe;
    } catch {
      logger.warn({ label }, "drone-role: could not fetch service-sector anchor state");
      return;
    }
    const targetFuel = Number(anchorProbe?.fuel?.deuterium) || 0;
    // Always persist the last-seen target fuel so the UI can display it.
    await deps.updateDroneRoleState(role.id, {
      lastTargetFuel: targetFuel,
      lastTargetFuelPercent: fuelPercent(anchorProbe),
    });

    const serviceSector = anchorProbe?.sector?.relative;
    if (!serviceSector) {
      logger.warn({ label }, "drone-role: service-sector anchor has no sector — may be in transit");
      return;
    }
    const targets = await getRefuelServiceTargets(serviceSector, threshold, role.id, deps);
    if (targets.length > 0) {
      logger.info(
        { label, targetIds: targets.map((target) => target.probeId), threshold, ourFuel, ourFuelPercent },
        "drone-role: eligible drones need fuel in the service sector — heading there",
      );
      await deps.updateDroneRoleState(role.id, {
        phase: "traveling_to_target",
        travelTarget: { x: serviceSector.x, y: serviceSector.y, z: serviceSector.z },
      });
    } else {
      logger.info({ label, targetFuel }, "drone-role: no eligible low-fuel drones in service sector — staying idle");
    }
    return;
  }

  if (phase === "traveling_to_source") {
    // A restart may find a refueler that already completed its source refill.
    if (refuelerTankIsFull(probe)) {
      logger.info(
        { label, ourFuel: probe?.fuel?.deuterium ?? 0, capacity: fuelCapacity(probe) },
        "drone-role: already fully fueled — returning to idle",
      );
      await deps.updateDroneRoleState(role.id, { phase: "idle" });
      return;
    }
    // Clear stale travel phases created before the percentage-based return
    // threshold was introduced. A refueler with more than 20% does not need
    // a source trip.
    if (!refuelerNeedsSourceTrip(probe)) {
      logger.info(
        { label, ourFuel: probe?.fuel?.deuterium ?? 0, ourFuelPercent: fuelPercent(probe) },
        "drone-role: refueler reserve is above return threshold — cancelling source trip",
      );
      await deps.updateDroneRoleState(role.id, { phase: "idle" });
      return;
    }
    if (isMoving) return; // wait for arrival
    if (atSector(probe, cfg.sourceSector)) {
      logger.info({ label }, "drone-role: arrived at source — refilling");
      await deps.updateDroneRoleState(role.id, { phase: "refilling" });
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
    // Stations fill to the model's actual maximum (including improvements).
    if (refuelerTankIsFull(probe)) {
      logger.info(
        { label, ourFuel: probe?.fuel?.deuterium ?? 0, capacity: fuelCapacity(probe) },
        "drone-role: tank full — returning to idle",
      );
      await deps.updateDroneRoleState(role.id, { phase: "idle" });
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
    const serviceSector = role.state.travelTarget;
    if (!serviceSector) {
      logger.warn({ label }, "drone-role: missing service-sector destination — returning to idle");
      await deps.updateDroneRoleState(role.id, { phase: "idle" });
      return;
    }
    if (atSector(probe, serviceSector)) {
      logger.info({ label }, "drone-role: arrived at service sector — checking eligible drones");
      await deps.updateDroneRoleState(role.id, { phase: "servicing_sector" });
      return;
    }
    logger.info({ label, target: serviceSector }, "drone-role: moving to service sector");
    try {
      await c.moveProbe(serviceSector.x, serviceSector.y, serviceSector.z);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: move to service sector failed");
    }
    return;
  }

  if (phase === "servicing_sector") {
    if (isMoving) return;
    if (refuelerNeedsSourceTrip(probe)) {
      await deps.updateDroneRoleState(role.id, {
        phase: atSector(probe, cfg.sourceSector) ? "refilling" : "traveling_to_source",
        servingTargetProbeId: undefined,
        servingTargetProbeName: undefined,
      });
      return;
    }
    const serviceSector = probe?.sector?.relative;
    if (!serviceSector) {
      logger.warn({ label }, "drone-role: no current sector while servicing");
      return;
    }
    const targets = await getRefuelServiceTargets(serviceSector, threshold, role.id, deps);
    const target = targets[0];
    if (!target) {
      logger.info({ label }, "drone-role: service sector has no remaining low-fuel drones");
      await deps.updateDroneRoleState(role.id, {
        phase: "idle",
        servingTargetProbeId: undefined,
        servingTargetProbeName: undefined,
      });
      return;
    }
    const claimedTarget = await deps.claimRefuelTarget(role.id, target.probeId, target.probeName);
    if (!claimedTarget) {
      logger.info({ label, targetProbeId: target.probeId }, "drone-role: another refueler claimed target — checking again later");
      return;
    }
    logger.info(
      { label, targetProbeId: target.probeId, targetFuel: target.fuel },
      "drone-role: claimed low-fuel drone in service sector",
    );
    return;
  }

  if (phase === "transferring") {
    if (isMoving) return;
    // Existing persisted roles may still be in the old transferring phase with
    // no explicit claim. In that case, preserve their configured anchor target.
    const targetProbeId = role.state.servingTargetProbeId ?? cfg.targetProbeId;
    const ourFuel = probe?.fuel?.deuterium ?? 0;
    const availableFuel = Math.floor(ourFuel) - MIN_DEUTERIUM_RESERVE;
    if (availableFuel <= 0) {
      logger.warn({ label, ourFuel }, "drone-role: not enough fuel to transfer — returning to source");
      await deps.updateDroneRoleState(role.id, {
        phase: atSector(probe, cfg.sourceSector) ? "refilling" : "traveling_to_source",
        servingTargetProbeId: undefined,
        servingTargetProbeName: undefined,
      });
      return;
    }

    // VNG returns any amount above the target's capacity to the tanker. Asking
    // only for the target's missing fuel keeps the transfer deterministic and
    // avoids a misleading oversized handoff / surplus return.
    let targetFuel = 0;
    let targetCapacity = 100;
    let targetFuelPercent = 0;
    try {
      const targetResp = await deps.clientFor(targetProbeId).getProbe();
      targetFuel = Number(targetResp?.probe?.fuel?.deuterium) || 0;
      targetCapacity = fuelCapacity(targetResp?.probe);
      targetFuelPercent = fuelPercent(targetResp?.probe);
      const currentSector = probe?.sector?.relative;
      if (!currentSector || !atSector(targetResp?.probe, currentSector)) {
        logger.info({ label, targetProbeId }, "drone-role: claimed target left service sector — releasing claim");
        await deps.updateDroneRoleState(role.id, {
          phase: "servicing_sector",
          servingTargetProbeId: undefined,
          servingTargetProbeName: undefined,
        });
        return;
      }
    } catch {
      logger.warn({ label }, "drone-role: could not fetch target fuel before transfer");
      return;
    }
    const targetMissingFuel = Math.max(0, Math.floor(targetCapacity - targetFuel));
    const transferable = Math.min(availableFuel, targetMissingFuel);
    if (transferable <= 0) {
      logger.info(
        { label, targetProbeId, targetFuel, targetCapacity },
        "drone-role: target tank is already full — no deuterium transfer needed",
      );
      await deps.updateDroneRoleState(role.id, {
        phase: "servicing_sector",
        lastTargetFuel: targetFuel,
        lastTargetFuelPercent: targetFuelPercent,
        servingTargetProbeId: undefined,
        servingTargetProbeName: undefined,
      });
      return;
    }

    // We already confirmed co-location via atSector in traveling_to_target.
    // Skip the redundant sector-object lookup (probeId type mismatches caused
    // false-negatives); let transferDeuteriumToProbe be the authoritative guard.
    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny for deuterium transfer");
      return;
    }
    logger.info(
      { label, amount: transferable, availableFuel, targetFuel, targetCapacity, mannyId: manny.id, targetProbeId },
      "drone-role: transferring deuterium",
    );
    try {
      await c.transferDeuteriumToProbe(manny.id, targetProbeId, transferable);
      claimed.add(manny.id);
      // Keep the target claim until the asynchronous Manny transfer completes.
      // The next tick observes the target's fresh fuel level and then moves on
      // to another eligible drone in this sector.
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: deuterium transfer failed — will retry next tick");
    }
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
    const currentSectorD = probe?.sector?.relative ?? null;
    if (!currentSectorD) return;
    const waypoint = await nextDeliveryWaypoint(currentSectorD, target, label);
    logger.info({ label, waypoint, finalTarget: target }, "drone-role: moving toward explorer sector");
    try {
      await c.moveProbe(waypoint.x, waypoint.y, waypoint.z);
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
      factorySector = resp?.probe?.sector?.relative ?? null;
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
    const currentSectorR = probe?.sector?.relative ?? null;
    if (!currentSectorR) return;
    const waypointR = await nextDeliveryWaypoint(currentSectorR, factorySector, label);
    logger.info({ label, waypoint: waypointR, finalTarget: factorySector }, "drone-role: returning to factory");
    try {
      await c.moveProbe(waypointR.x, waypointR.y, waypointR.z);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: return move failed");
    }
    return;
  }
}

// ── Explorer Role ─────────────────────────────────────────────────────────────
//
// Revised logic:
//   • WP bookmark installed at EVERY sector (on arrival), not just where a relay lands.
//   • SCUT relay deployed ONLY when the NEXT hop is outside coverage of any active relay.
//   • Bookmark name format: "WP-NNN- PlayerName. This is X.Y.Z M Metal. D Deut. I Ice. O Organics"

const SCUT_RADIUS = 10; // default coverage radius in sectors (Euclidean distance)

/**
 * Returns true if `nextSector` is within coverage of any active SCUT relay.
 *
 * Uses locally-stored visited-sector data to discover network IDs, then queries
 * the game's per-network endpoint for authoritative relay positions and radius.
 * The global `/api/probe/scut-networks` endpoint does not exist (404); this
 * replicates the same aggregation that the local /api/vng/scut-networks route
 * performs.  Fails open so the explorer keeps moving if data is unavailable.
 */
async function isInScutCoverage(
  nextSector: { x: number; y: number; z: number },
  label: string,
): Promise<boolean> {
  try {
    // Collect network IDs from locally-cached sector objects.
    const networkIds = new Set<number>();
    const sectors = await getSectors();
    for (const s of sectors) {
      for (const obj of (s.objects ?? []) as any[]) {
        if (obj.type === "scut_relay" && obj.network?.id) {
          networkIds.add(obj.network.id as number);
        }
      }
    }

    if (networkIds.size === 0) return false;

    // Fetch relay data for every known network.
    const results = await Promise.allSettled(
      [...networkIds].map((id) => getScutNetwork(id)),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const net = r.value?.network;
      for (const relay of (net?.relays ?? [])) {
        // VNG relay status is "on" | "off" (not a boolean active field).
        if (relay.status !== "on") continue;
        const rx: number = relay.sector?.relative?.x ?? 0;
        const ry: number = relay.sector?.relative?.y ?? 0;
        const rz: number = relay.sector?.relative?.z ?? 0;
        const radius: number = relay.coverageRadiusSectors ?? SCUT_RADIUS;
        const dist = Math.sqrt(
          (nextSector.x - rx) ** 2 +
          (nextSector.y - ry) ** 2 +
          (nextSector.z - rz) ** 2,
        );
        if (dist <= radius) return true;
      }
    }
    return false;
  } catch (err: any) {
    logger.warn({ label, err: err?.message }, "drone-role: SCUT coverage check failed — assuming covered");
    return true; // fail open so explorer keeps moving
  }
}

type ResourceCounts = { metal: number; deut: number; ice: number; organics: number };

/** Count mineable resources across standalone objects and solar-system bodies. */
function countSectorResources(sectorObjects: any[]): ResourceCounts {
  const counts: ResourceCounts = { metal: 0, deut: 0, ice: 0, organics: 0 };
  const tally = (rt: string) => {
    const r = rt.toLowerCase();
    if (r === "metals" || r === "metal") counts.metal++;
    else if (r === "deuterium") counts.deut++;
    else if (r === "ice") counts.ice++;
    else if (r === "carbon_compounds" || r === "organics") counts.organics++;
  };

  // Raw VNG solar-system objects keep asteroid resources in minableTargets,
  // with object IDs in bookmarkTargets. The shared mapper merges those arrays
  // into complete bodies, so the waypoint sees the same mineable targets as
  // mining automation.
  for (const obj of mapSectorObjects(sectorObjects)) {
    if (obj.type === "solar_system") {
      for (const body of (obj.bodies ?? [])) {
        for (const rt of (body.resourceTypes ?? [])) tally(rt as string);
      }
    } else {
      for (const rt of (obj.resourceTypes ?? [])) tally(rt as string);
    }
  }
  return counts;
}

/** True when the current sector already contains any waypoint beacon. */
function hasExistingWaypoint(sectorObjects: any[]): boolean {
  const containsWaypoint = (object: any): boolean => {
    if (!object || typeof object !== "object") return false;
    if (Array.isArray(object.waypointBookmarks) && object.waypointBookmarks.length > 0) {
      return true;
    }
    return Array.isArray(object.bodies) && object.bodies.some(containsWaypoint);
  };
  return sectorObjects.some(containsWaypoint);
}

/** Build the standard WP bookmark name. */
function buildWpName(
  counter: number,
  playerName: string,
  sector: { x: number; y: number; z: number },
  res: ResourceCounts,
): string {
  const num = String(counter).padStart(3, "0");
  return `WP-${num}- ${playerName}. This is ${sector.x}.${sector.y}.${sector.z} ${res.metal} Metal. ${res.deut} Deut. ${res.ice} Ice. ${res.organics} Organics`;
}

export async function runExplorerRole(
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
  const currentSector = probe?.sector?.relative ?? null;
  const playerName = cfg.playerName ?? "Explorer";

  // ── idle ──────────────────────────────────────────────────────────────────
  // Decision point: check SCUT coverage for next hop and either move or relay.
  if (phase === "idle") {
    if (!currentSector) return;
    if (reachedTarget(currentSector, cfg.targetVector)) {
      logger.info({ label }, "drone-role: explorer reached target vector — done");
      return;
    }

    // Check SCUT coverage for the next sector.
    const next = nextSectorToward(currentSector, cfg.targetVector);
    const covered = await isInScutCoverage(next, label);

    if (!covered) {
      logger.info({ label, next }, "drone-role: explorer — next sector out of SCUT range → deploying relay");
      await updateDroneRoleState(role.id, { phase: "deploying_relay", travelTarget: next });
      return;
    }

    // Next sector is covered — move directly.
    logger.info({ label, next }, "drone-role: explorer — next sector in SCUT range → moving");
    try {
      await c.moveProbe(next.x, next.y, next.z);
      await updateDroneRoleState(role.id, { phase: "traveling", travelTarget: next });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: explorer move failed");
    }
    return;
  }

  // ── traveling ─────────────────────────────────────────────────────────────
  if (phase === "traveling") {
    if (isMoving) return;
    logger.info({ label, sector: currentSector }, "drone-role: explorer arrived — checking next hop");
    await updateDroneRoleState(role.id, { phase: "idle" });
    return;
  }

  // ── installing_beacon ─────────────────────────────────────────────────────
  // Runs after a relay is activated: install WP on that relay, then drop the
  // container and request delivery. This phase is never reached merely by
  // arriving in a covered sector.
  if (phase === "installing_beacon") {
    if (isMoving) return;

    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch { return; }

    const activeRelay = sectorObjects.find(isActiveRelay);
    if (!activeRelay && !hasExistingWaypoint(sectorObjects)) {
      logger.warn({ label }, "drone-role: no active relay for waypoint installation — deferring");
      return;
    }

    // Install waypoint bookmark on the active relay.
    const items: any[] = probe?.inventory?.items ?? [];
    const hasBookmark = items.some((i: any) => i.type === "waypoint_bookmark");

    if (hasExistingWaypoint(sectorObjects)) {
      logger.info({ label }, "drone-role: waypoint already exists — skipping WP installation");
      await recordExplorerWaypointEvent({
        explorerId: role.probeId,
        explorerName: role.probeName,
        sector: currentSector ?? { x: 0, y: 0, z: 0 },
        event: {
          key: `skipped:${currentSector?.x},${currentSector?.y},${currentSector?.z}`,
          type: "skipped",
          reason: "waypoint already exists in this sector",
        },
      }).catch((err: any) => logger.warn({ label, err: err?.message }, "drone-role: could not journal waypoint skip"));
    } else if (activeRelay && hasBookmark) {
      const manny = pickIdleManny(mannies, claimed);
      if (!manny) {
        logger.info({ label }, "drone-role: no idle manny for WP installation — deferring");
        return;
      }
      const counter = role.state.wpCounter ?? (cfg.wpStartNumber ?? 1);
      const res = countSectorResources(sectorObjects);
      const name = buildWpName(counter, playerName, currentSector ?? { x: 0, y: 0, z: 0 }, res);
      logger.info({ label, name, objectId: activeRelay.id }, "drone-role: installing waypoint bookmark on relay");
      try {
        await c.installWaypointBookmark(manny.id, activeRelay.id, name);
        claimed.add(manny.id);
        await updateDroneRoleState(role.id, { wpCounter: counter + 1 });
        await recordExplorerWaypointEvent({
          explorerId: role.probeId,
          explorerName: role.probeName,
          sector: currentSector ?? { x: 0, y: 0, z: 0 },
          event: {
            key: `installed:${activeRelay.id}`,
            type: "installed",
            name,
            relayId: String(activeRelay.id),
            targetObjectId: String(activeRelay.id),
            targetObjectName: activeRelay.name ?? null,
          },
        }).catch((err: any) => logger.warn({ label, err: err?.message }, "drone-role: could not journal waypoint installation"));
      } catch (err: any) {
        logger.warn({ label, err: err?.message }, "drone-role: WP installation failed — continuing");
        await recordExplorerWaypointEvent({
          explorerId: role.probeId,
          explorerName: role.probeName,
          sector: currentSector ?? { x: 0, y: 0, z: 0 },
          event: {
            key: `failed:${activeRelay.id}:${counter}`,
            type: "failed",
            name,
            reason: err?.message ?? "installation failed",
            relayId: String(activeRelay.id),
            targetObjectId: String(activeRelay.id),
            targetObjectName: activeRelay.name ?? null,
          },
        }).catch((journalErr: any) => logger.warn({ label, err: journalErr?.message }, "drone-role: could not journal waypoint failure"));
        // Increment anyway to avoid re-trying the same counter on the next tick.
        await updateDroneRoleState(role.id, { wpCounter: counter + 1 });
      }
    } else if (!hasBookmark) {
      logger.warn({ label }, "drone-role: no waypoint_bookmark in inventory — waiting before delivery");
      return;
    }

    await updateDroneRoleState(role.id, { phase: "dropping_container" });
    return;
  }

  // ── deploying_relay ───────────────────────────────────────────────────────
  // Only reached when the next hop is out of SCUT coverage. Place a relay
  // at the CURRENT sector so it covers the next hop (≤1 step away ≤ radius).
  if (phase === "deploying_relay") {
    if (isMoving) return;
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch { return; }

    const inactiveRelay = sectorObjects.find(isInactiveRelay);
    if (inactiveRelay) {
      logger.info({ label, relayId: inactiveRelay.id }, "drone-role: inactive relay found — activating");
      await updateDroneRoleState(role.id, { phase: "activating_relay" });
      return;
    }

    const activeRelay = sectorObjects.find(isActiveRelay);
    if (activeRelay) {
      logger.info({ label }, "drone-role: relay already active — installing waypoint");
      await updateDroneRoleState(role.id, { phase: "installing_beacon" });
      return;
    }

    // No relay object in sector. Deploy one from inventory: per the VNG
    // OpenAPI spec, POST /inventory/{itemId}/jettison on a scut_relay item
    // "deploys a scut_relay item as an inactive SCUT relay in the current
    // sector". Then the next tick sees the inactive relay and advances to
    // activating_relay.
    const items: any[] = probe?.inventory?.items ?? [];
    const relayItem = items.find((i: any) => i.type === "scut_relay");
    if (relayItem) {
      logger.info({ label, itemId: relayItem.id }, "drone-role: deploying scut_relay from inventory (jettison)");
      try {
        await c.jettisonItem(relayItem.id);
        // Don't advance yet — re-scan next tick so we pick up the real
        // sector object (and its ID) before activation.
      } catch (err: any) {
        logger.warn({ label, err: err?.message }, "drone-role: relay deployment (jettison) failed");
      }
      return;
    }

    // No relay item either — have an idle Manny craft one. Crafting is a
    // long-running task; subsequent ticks keep landing here until the
    // finished scut_relay shows up in probe inventory.
    const crafting = mannies.some(
      (m: any) => m.currentTask === "craft" || m.currentTask === "crafting",
    );
    if (crafting) {
      logger.info({ label }, "drone-role: scut_relay craft in progress — waiting");
      return;
    }
    const manny = pickIdleManny(mannies, claimed);
    if (!manny) {
      logger.info({ label }, "drone-role: no idle manny to craft scut_relay");
      return;
    }
    logger.info({ label, mannyId: manny.id }, "drone-role: crafting scut_relay");
    try {
      await c.craftItem(manny.id, "scut_relay");
      claimed.add(manny.id);
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: scut_relay craft failed (missing ingredients?)");
    }
    return;
  }

  // ── activating_relay ──────────────────────────────────────────────────────
  if (phase === "activating_relay") {
    if (isMoving) return;
    let sectorObjects: any[] = [];
    try {
      const resp = await c.getSector();
      sectorObjects = resp?.sector?.objects ?? [];
    } catch { return; }

    const inactiveRelay = sectorObjects.find(isInactiveRelay);
    if (!inactiveRelay) {
      if (sectorObjects.find(isActiveRelay)) {
        await updateDroneRoleState(role.id, { phase: "installing_beacon" });
      }
      return;
    }

    const items: any[] = probe?.inventory?.items ?? [];
    const hasIC = items.some((i: any) => i.type === "integrated_circuit");
    if (!hasIC) {
      logger.warn({ label }, "drone-role: no integrated_circuit for relay activation — waiting");
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
      // The relay must be active before the waypoint is installed on it.
      await updateDroneRoleState(role.id, { phase: "installing_beacon" });
    } catch (err: any) {
      logger.warn({ label, err: err?.message }, "drone-role: relay activation failed");
    }
    return;
  }

  // ── dropping_container ────────────────────────────────────────────────────
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
    logger.info({ label, containerId: container.id }, "drone-role: dropping container");
    try {
      await c.detachContainer(manny.id, container.id, "drifting");
      claimed.add(manny.id);
      await updateDroneRoleState(role.id, { phase: "waiting_for_delivery" });
    } catch (err: any) {
      // 404 means the container is already gone (dropped or collected); advance anyway.
      if (err instanceof VngApiError && err.status === 404) {
        logger.info({ label, containerId: container.id }, "drone-role: container not found on drop — treating as already dropped");
        await updateDroneRoleState(role.id, { phase: "waiting_for_delivery" });
      } else {
        logger.warn({ label, err: err?.message }, "drone-role: drop container failed");
      }
    }
    return;
  }

  // ── waiting_for_delivery ──────────────────────────────────────────────────
  if (phase === "waiting_for_delivery") {
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

export function isActiveRelay(o: any): boolean {
  return o?.type === "scut_relay" && (o.status === "on" || o.active === true);
}
