import { logger } from "../../lib/logger.js";
import { clientFor, VngApiError } from "./client.js";
import {
  getPendingActions,
  resolvePendingAction,
  getMiningAssignments,
  updateMiningCycleState,
  toSectorObjectId,
  type PendingAction,
  type MiningAssignment,
} from "./file-store.js";
import { mapSectorObjects } from "./sector-map.js";

const POLL_INTERVAL_MS = 30_000;
let started = false;

// Probes where every crafting attempt last tick returned "insufficient resources".
// When a probe is in this set, the crafting reserve is dropped to 0 so all
// mannies are available for mining until materials arrive.
const craftingMaterialsBlocked = new Set<string>();

/**
 * Distribute `capacity` across `n` mannies in multiples of 0.05.
 * Mannies that get the larger slice come first.
 * e.g. distributeAmounts(1.0, 3) → [0.35, 0.35, 0.30]
 */
function distributeAmounts(capacity: number, n: number): number[] {
  if (n <= 0) return [];
  const UNIT = 0.05;
  const totalUnits = Math.round(capacity / UNIT);
  const baseUnits = Math.floor(totalUnits / n);
  const extraCount = totalUnits % n;
  return Array.from({ length: n }, (_, i) =>
    parseFloat(((i < extraCount ? baseUnits + 1 : baseUnits) * UNIT).toFixed(4))
  );
}

/**
 * Persist a row's terminal status without letting a write failure abort the
 * probe's remaining rows.
 *
 * This matters more than it looks: a row is only marked "triggered" *after* its
 * game action has already been sent. If that write throws and takes the loop
 * with it, the row stays pending and the next tick sends the same action a
 * second time — a duplicate move/detach/craft against the live game.
 */
async function resolveQuietly(
  actionId: number,
  patch: { status: "triggered" | "failed"; error?: string },
): Promise<void> {
  try {
    await resolvePendingAction(actionId, patch);
  } catch (err: any) {
    logger.error(
      { actionId, patch, err: err?.message ?? String(err) },
      "poller: could not persist action status — row may re-fire next tick",
    );
  }
}

/**
 * Is a failed probe fetch worth retrying, or is the probe simply gone?
 *
 * A network error (fetch rejects: timeout, ECONNRESET, DNS) is transient — skip
 * the probe's rows this tick and try again next tick. Only a genuinely permanent
 * status fails the rows loudly: 404 (probe decommissioned while a row still
 * targeted it), 410 (gone), and 400 (a malformed request that won't change on
 * retry). Everything else is retried — critically 401/403, since an expired or
 * rotated VNG_API_KEY hits EVERY probe and failing the whole queue over a
 * recoverable auth blip is worse than waiting, plus 408/425/429 and all 5xx.
 * client.ts throws VngApiError with a numeric `.status` field.
 */
const PERMANENT_FETCH_STATUS = new Set([400, 404, 410]);
function isPermanentFetchError(err: unknown): boolean {
  const status = (err as any)?.status;
  return typeof status === "number" && PERMANENT_FETCH_STATUS.has(status);
}

async function executeAction(
  action: PendingAction,
  selectedMannyId: string | null,
  c: ReturnType<typeof clientFor>
): Promise<void> {
  const a = action.action;
  const mannyId = selectedMannyId ?? (a as any).mannyId as string | undefined;

  switch (a.type) {
    case "move_probe":
      await c.moveProbe(a.x, a.y, a.z);
      break;
    case "craft_item":
      if (!mannyId) throw new Error("craft_item: no Manny selected");
      await c.craftItem(mannyId, a.recipe);
      break;
    case "atomic_printer_craft":
      await c.atomicPrinterCraft(a.recipe);
      break;
    case "mine_resources":
      await c.mineResources(
        a.mannyId,
        a.objectId,
        a.resources,
        a.targetAmount,
        a.targetContainerId
      );
      break;
    case "detach_container":
      await c.detachContainer(a.mannyId, a.containerId);
      break;
    case "recover_container":
      await c.recoverContainer(a.mannyId, a.objectId);
      break;
    default: {
      // Compile-time exhaustiveness: a new PendingActionPayload variant becomes
      // a type error here rather than a silent runtime throw at poll time.
      const _exhaustive: never = a;
      void _exhaustive;
      throw new Error(
        `Unknown action type: ${(a as { type?: string })?.type ?? "?"}`,
      );
    }
  }
}

// ── Mining automation ────────────────────────────────────────────────────────

async function runMiningAutomation(
  probeId: number | null,
  probe: any,
  mannies: any[],
  claimedMannies: Set<string>,
  c: ReturnType<typeof clientFor>,
  craftingReserve: number,
): Promise<void> {
  const allAssignments = await getMiningAssignments().catch(() => []);
  const assignments = allAssignments.filter(
    (a) => a.enabled && (a.probeId ?? null) === (probeId ?? null)
  );
  if (assignments.length === 0) return;

  // Fetch sector once for all assignments this tick
  let sectorObjects: any[] = [];
  try {
    const sectorResp = await c.getSector();
    sectorObjects = sectorResp?.sector?.objects ?? [];
  } catch (err: any) {
    logger.warn({ probeId, err: err.message }, "mining: sector fetch failed, skipping this tick");
    return;
  }

  // Collect mineable targets from solar_system bodies and standalone asteroids
  const mappedSector = mapSectorObjects(sectorObjects);
  const asteroids: any[] = [];
  for (const obj of mappedSector) {
    if (obj.type === "solar_system") {
      for (const body of (obj.bodies ?? [])) {
        const rt: string[] = body.resourceTypes ?? [];
        if (rt.length > 0) {
          asteroids.push({
            id: body.id,
            name: body.name ?? `${body.type} (${body.category ?? body.type})`,
            resourceTypes: rt,
            type: body.type,
          });
        }
      }
    } else if (obj.type === "asteroid" && obj.mannyMineable !== false) {
      const rt: string[] = obj.resourceTypes ?? [];
      if (rt.length > 0) {
        asteroids.push({
          id: obj.id,
          name: obj.name ?? "Unnamed asteroid",
          resourceTypes: rt,
          type: "asteroid",
        });
      }
    }
  }

  for (const assignment of assignments) {
    try {
      if (assignment.assignmentMode === "drift") {
        await runDriftCycle(assignment, probe, mannies, claimedMannies, c);
      } else {
        await runMiningCycle(assignment, probe, mannies, claimedMannies, c, asteroids, sectorObjects, craftingReserve);
      }
    } catch (err: any) {
      // 409 = manny busy; defer silently without marking lastError
      if (err instanceof VngApiError && err.status === 409) {
        logger.info({ assignmentId: assignment.id }, "drift/mining: manny busy (409), deferring");
        return;
      }
      // 422 "Target detached container is full" — usedCapacity may not be
      // reported in inventory; treat as a transient guard failure, defer quietly.
      if (err instanceof VngApiError && err.status === 422 &&
          typeof err.message === "string" && err.message.includes("full")) {
        logger.info({ assignmentId: assignment.id, err: err.message }, "drift: container full (422), deferring");
        return;
      }
      logger.error(
        { assignmentId: assignment.id, err: err.message },
        "drift/mining: cycle error"
      );
      await updateMiningCycleState(assignment.id, { lastError: err.message }).catch(() => {});
    }
  }
}

// ── Drift cycle ───────────────────────────────────────────────────────────────
// "drift" assignments: one manny detaches the container in "drifting" mode so
// it floats in sector for other probes' mannies to pick up.  If the container
// ever comes back to inventory (another probe returned it, or it was never
// picked up), the cycle restarts automatically.
async function runDriftCycle(
  assignment: MiningAssignment,
  probe: any,
  mannies: any[],
  claimedMannies: Set<string>,
  c: ReturnType<typeof clientFor>,
): Promise<void> {
  const label = `drift assignment ${assignment.id} (${assignment.material})`;
  const invContainers: any[] = (probe?.inventory?.containers ?? []).filter(
    (c: any) =>
      (typeof c.kind === "string" && c.kind.toLowerCase().includes("container")) ||
      (c.capacity != null && c.capacity > 0)
  );
  const container = invContainers.find((c: any) => c.id === assignment.containerId);

  if (assignment.cycleState === "idle") {
    if (!container) {
      // Not in inventory — may already be drifting from a prior cycle
      logger.info({ label }, "drift: container not in inventory — skipping");
      return;
    }
    // Only detach when the container is empty — don't jettison cargo.
    if ((container.usedCapacity ?? 0) > 0) {
      logger.info(
        { label, usedCapacity: container.usedCapacity },
        "drift: container not empty yet — waiting for unload"
      );
      return;
    }
    const manny = mannies.find(
      (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
    );
    if (!manny) {
      logger.info({ label }, "drift: no idle manny available — deferring");
      return;
    }
    claimedMannies.add(manny.id as string);
    await c.detachContainer(manny.id as string, assignment.containerId, "drifting");
    await updateMiningCycleState(assignment.id, {
      cycleState: "deploying",
      miningMannyIds: [manny.id as string],
      lastCycleAt: new Date().toISOString(),
      lastError: undefined,
    });
    logger.info({ label, mannyId: manny.id }, "drift: detach dispatched — container leaving drifting");

  } else if (assignment.cycleState === "deploying") {
    const [mannyId] = assignment.miningMannyIds ?? [];
    const manny = mannies.find((m: any) => m.id === mannyId);

    if (manny?.currentTask) {
      // Still travelling to deploy position
      logger.info({ label, task: manny.currentTask }, "drift: manny en route — waiting");
      return;
    }

    // Manny is idle (or gone) — deployment complete
    if (!container) {
      logger.info({ label }, "drift: container deployed — drifting in sector");
      await updateMiningCycleState(assignment.id, { cycleState: "deployed", miningMannyIds: [] });
    } else {
      // Container unexpectedly still in inventory — reset
      logger.info({ label }, "drift: manny done but container still in inventory — resetting");
      await updateMiningCycleState(assignment.id, { cycleState: "idle", miningMannyIds: [] });
    }

  } else if (assignment.cycleState === "deployed") {
    if (container) {
      // Container came back (rare — another probe returned it, or cycle mismatch)
      logger.info({ label }, "drift: container returned to inventory — restarting cycle");
      await updateMiningCycleState(assignment.id, { cycleState: "idle", miningMannyIds: [] });
    }
    // Otherwise quietly waiting — no log spam
  }
}

async function runMiningCycle(
  assignment: MiningAssignment,
  probe: any,
  mannies: any[],
  claimedMannies: Set<string>,
  c: ReturnType<typeof clientFor>,
  asteroids: any[],
  rawSectorObjects: any[],
  craftingReserve: number,
): Promise<void> {
  const label = `mining assignment ${assignment.id} (${assignment.material})`;

  if (assignment.cycleState === "idle") {
    // Container must be in probe inventory
    const invContainers: any[] = (probe?.inventory?.containers ?? []).filter(
      (c: any) =>
        (typeof c.kind === "string" && c.kind.toLowerCase().includes("container")) ||
        (c.capacity != null && c.capacity > 0)
    );
    const container = invContainers.find((c: any) => c.id === assignment.containerId);
    if (container && (container.usedCapacity ?? 0) >= 0.99) {
      logger.info(
        { label, usedCapacity: container.usedCapacity },
        "mining: container still full in inventory — waiting for unload before next cycle"
      );
      return;
    }
    if (!container) {
      // Container not in inventory — check if it's already deployed in sector
      const deployedId = toSectorObjectId(assignment.containerId);
      const isDeployed = rawSectorObjects.some(
        (o: any) => o.id === deployedId || o.id === assignment.containerId
      );
      if (isDeployed) {
        // Sync state: container is out on an asteroid.
        // Only track mannies that are actually doing a mining task — grabbing ALL
        // busy mannies (including crafters) causes immediate stale-ejection and
        // a premature recovery on the very next tick.
        const deployedObj = rawSectorObjects.find(
          (o: any) => o.id === deployedId || o.id === assignment.containerId
        );
        const syncedAsteroid: string | undefined =
          assignment.asteroidObjectId ??
          (deployedObj?.targetObjectId as string | undefined) ??
          (deployedObj?.anchorObjectId as string | undefined);

        const busyMiningIds = mannies
          .filter((m: any) => {
            if (!m.currentTask) return false;
            const taskStr = String(m.currentTask).toLowerCase();
            return /^min(e|ing)/.test(taskStr);
          })
          .map((m: any) => m.id as string);

        if (busyMiningIds.length === 0) {
          // No miners working — go straight to recovery rather than waiting in mining state.
          logger.info({ label }, "mining: container deployed but no active miners — dispatching recovery");
          const recoverer = mannies.find(
            (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
          );
          if (!recoverer) {
            logger.info({ label }, "mining: no idle manny for recovery, deferring");
            return;
          }
          claimedMannies.add(recoverer.id as string);
          const containerObjId = toSectorObjectId(assignment.containerId);
          await c.recoverContainer(recoverer.id as string, containerObjId);
          logger.info({ label, mannyId: recoverer.id }, "mining: recovery dispatched");
          await updateMiningCycleState(assignment.id, {
            cycleState: "recovering",
            miningMannyIds: [],
            lastError: undefined,
          });
          return;
        }

        // Read capacity from the sector object if not already stored.
        const syncedCapacity: number | undefined =
          assignment.containerCapacity && assignment.containerCapacity > 1
            ? assignment.containerCapacity
            : (deployedObj?.capacity as number | undefined) ?? undefined;

        logger.info({ label, busyMiningIds, syncedAsteroid }, "mining: container already deployed — syncing to mining state");
        await updateMiningCycleState(assignment.id, {
          cycleState: "mining",
          miningMannyIds: busyMiningIds,
          ...(syncedAsteroid ? { asteroidObjectId: syncedAsteroid } : {}),
          ...(syncedCapacity ? { containerCapacity: syncedCapacity } : {}),
          lastError: undefined,
        });
      } else {
        logger.info({ label }, "mining: container not in inventory or sector, skipping");
      }
      return;
    }

    // Find an asteroid with the matching material
    const asteroid = asteroids.find((a: any) =>
      (a.resourceTypes ?? []).includes(assignment.material)
    );
    if (!asteroid) {
      logger.info({ label, material: assignment.material }, "mining: no matching asteroid in sector, skipping");
      return;
    }

    // Claim N idle mannies (unclaimed, no currentTask).
    // Respect the crafting reserve: leave at least `craftingReserve` mannies
    // free for the scheduled-task queue so mining never fully starves crafting.
    const available = mannies.filter(
      (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
    );
    const claimable = Math.max(0, available.length - craftingReserve);
    if (claimable === 0) {
      logger.info(
        { label, have: available.length, reserved: craftingReserve },
        "mining: no mannies available after crafting reserve, deferring"
      );
      return;
    }
    // mannyCount is the maximum — use however many are claimable up to that cap.
    const selected = available.slice(0, Math.min(claimable, assignment.mannyCount));
    for (const m of selected) claimedMannies.add(m.id as string);

    const capacity: number = container.capacity ?? 1;
    const perManny = capacity / assignment.mannyCount;
    const containerObjectId = toSectorObjectId(assignment.containerId);

    // 1. First manny detaches the container on the asteroid
    await c.detachContainer(
      selected[0].id as string,
      assignment.containerId,
      "hidden_on_asteroid",
      asteroid.id as string
    );
    logger.info(
      { label, mannyId: selected[0].id, asteroidId: asteroid.id },
      "mining: container detached on asteroid"
    );

    // Save state immediately after the detach succeeds.  We do NOT dispatch
    // mineResources here — the container doesn't physically exist on the
    // asteroid until the detaching manny arrives (the API returns 404 if you
    // try before that).  The mining-state handler issues mine tasks once the
    // container appears in sector.
    await updateMiningCycleState(assignment.id, {
      cycleState: "mining",
      asteroidObjectId: asteroid.id as string,
      miningMannyIds: selected.map((m: any) => m.id as string),
      containerCapacity: capacity,
      lastCycleAt: new Date().toISOString(),
      lastError: undefined,
    });

  } else if (assignment.cycleState === "mining") {
    let miningIds = assignment.miningMannyIds ?? [];

    // Guard: miningIds must never exceed mannyCount — trim if corrupted.
    if (miningIds.length > assignment.mannyCount) {
      logger.warn(
        { label, tracked: miningIds.length, cap: assignment.mannyCount },
        "mining: miningIds exceeds mannyCount — trimming to cap"
      );
      miningIds = miningIds.slice(0, assignment.mannyCount);
      await updateMiningCycleState(assignment.id, { miningMannyIds: miningIds });
    }

    // If we dispatched fewer mannies than requested (e.g. not enough were idle
    // at cycle start), recruit additional idle mannies now rather than waiting
    // for the original set to finish with an under-filled container.
    //
    // Derive asteroidObjectId from the deployed container's anchor when the
    // field was not stored (assignments created before this field was added).
    const deployedContainerObj = rawSectorObjects.find(
      (o: any) => o.id === toSectorObjectId(assignment.containerId)
    );
    const effectiveAsteroidId: string | undefined =
      assignment.asteroidObjectId ??
      (deployedContainerObj?.targetObjectId as string | undefined) ??
      (deployedContainerObj?.anchorObjectId as string | undefined);

    const cap: number =
      assignment.containerCapacity ??
      (deployedContainerObj?.capacity as number | undefined) ??
      1;
    const containerObjectId = toSectorObjectId(assignment.containerId);

    // ── Step 1: classify tracked mannies ────────────────────────────────────
    // A tracked manny can be in one of three states:
    //   • active  — has a non-crafting currentTask (mining, detaching, moving)
    //   • pending — currently idle; the container may now be ready for mine dispatch
    //   • stale   — explicitly crafting; remove from list
    const stillActive: string[] = [];
    const pendingDispatch: any[] = [];
    const staleIds: string[] = [];

    for (const id of miningIds) {
      const m = mannies.find((m: any) => m.id === id);
      if (!m) continue;
      if (!m.currentTask) {
        pendingDispatch.push(m);
      } else {
        const taskStr = String(m.currentTask).toLowerCase();
        if (/^craft/.test(taskStr)) {
          staleIds.push(id);
          logger.info(
            { label, mannyId: id, task: m.currentTask },
            "mining: crafting manny in list — removing from cycle"
          );
        } else {
          stillActive.push(id);
        }
      }
    }

    if (staleIds.length > 0) {
      miningIds = miningIds.filter((id) => !staleIds.includes(id));
      await updateMiningCycleState(assignment.id, { miningMannyIds: miningIds });
    }

    // ── Step 2: check whether the container is physically on the asteroid ────
    // mineResources returns 404 until the detaching manny arrives and places the
    // container.  Gate all mine dispatches on the container appearing in sector.
    const containerInSector = rawSectorObjects.some(
      (o: any) => o.id === containerObjectId || o.id === assignment.containerId
    );

    if (!containerInSector) {
      // Container not yet placed — manny is still en route.
      const activeTasks = stillActive.length + pendingDispatch.length;
      if (activeTasks > 0) {
        logger.info(
          { label, activeTasks },
          "mining: waiting for detaching manny to place container"
        );
      } else {
        // All tracked mannies are idle and container is missing — lost in transit.
        logger.info({ label }, "mining: container lost in transit — dispatching recovery");
        const recoverer = mannies.find(
          (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
        );
        if (recoverer) {
          claimedMannies.add(recoverer.id as string);
          await c.recoverContainer(recoverer.id as string, containerObjectId);
          await updateMiningCycleState(assignment.id, { cycleState: "recovering", miningMannyIds: [] });
        }
      }
      return;
    }

    // ── Step 3: container is in sector — dispatch mine to idle tracked mannies ─
    // Distribute cap across all currently tracked miners in 0.05-aligned amounts.
    // Mannies already active have amounts from a prior dispatch; pendingDispatch
    // mannies get the tail of the distribution (indices stillActive.length onward).
    //
    // Skip re-dispatch entirely if the container is already full — the mannies
    // have finished their work and we should fall through to recovery (step 5).
    const containerUsedCapacity: number = deployedContainerObj?.usedCapacity ?? 0;
    const containerFull = containerUsedCapacity >= 0.99;
    if (containerFull) {
      logger.info(
        { label, usedCapacity: containerUsedCapacity },
        "mining: container full in sector — skipping mine re-dispatch, proceeding to recovery"
      );
    }
    if (!containerFull && pendingDispatch.length > 0 && effectiveAsteroidId) {
      const trackedTotal = stillActive.length + pendingDispatch.length;
      const amounts = distributeAmounts(cap, trackedTotal);
      // IMPORTANT: snapshot length before the loop — stillActive.push() inside the
      // loop would otherwise shift the index for every subsequent iteration, causing
      // later mannies to read undefined from amounts[] and send targetAmount:undefined.
      const baseIdx = stillActive.length;
      let step3AnySucceeded = false;
      for (let i = 0; i < pendingDispatch.length; i++) {
        const m = pendingDispatch[i];
        const amount = amounts[baseIdx + i];
        try {
          await c.mineResources(
            m.id as string,
            effectiveAsteroidId!,
            [assignment.material],
            amount,
            containerObjectId
          );
          stillActive.push(m.id as string);
          step3AnySucceeded = true;
          logger.info({ label, mannyId: m.id, amount }, "mining: dispatched mine to idle tracked manny");
        } catch (err: any) {
          if (err instanceof VngApiError && err.status === 409) {
            stillActive.push(m.id as string); // still busy — count as active
          } else {
            throw err;
          }
        }
      }
      // Clear any stale error badge now that at least one dispatch succeeded.
      if (step3AnySucceeded) {
        await updateMiningCycleState(assignment.id, { lastError: undefined }).catch(() => {});
      }
    }

    // ── Step 4: fill any remaining slots with fresh idle mannies ────────────
    // mannyCount is the max; fill up to that cap (or fewer if the reserve limits it).
    const stillNeeded = assignment.mannyCount - miningIds.length;
    if (stillNeeded > 0 && effectiveAsteroidId) {
      const extraAvailable = mannies.filter(
        (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
      );
      const extraClaimable = Math.max(0, extraAvailable.length - craftingReserve);
      if (extraClaimable > 0) {
        const toAdd = extraAvailable.slice(0, Math.min(stillNeeded, extraClaimable));
        // Each fill-slot manny gets a base 0.05-aligned amount.
        // (Existing miners already have dispatched amounts we cannot change.)
        const totalAfter = miningIds.length + toAdd.length;
        const fillAmounts = distributeAmounts(cap, totalAfter);
        for (let i = 0; i < toAdd.length; i++) {
          const m = toAdd[i];
          const amount = fillAmounts[miningIds.length + i];
          await c.mineResources(
            m.id as string,
            effectiveAsteroidId,
            [assignment.material],
            amount,
            containerObjectId
          );
          claimedMannies.add(m.id as string);
          stillActive.push(m.id as string);
        }
        miningIds = [...miningIds, ...toAdd.map((m: any) => m.id as string)];
        await updateMiningCycleState(assignment.id, {
          miningMannyIds: miningIds,
          containerCapacity: cap,
          asteroidObjectId: effectiveAsteroidId,
          lastError: undefined,
        });
        logger.info(
          { label, added: toAdd.length, total: miningIds.length },
          "mining: filled remaining manny slots"
        );
      }
    }

    // ── Step 5: wait or recover ──────────────────────────────────────────────
    if (stillActive.length > 0) {
      logger.info(
        { label, activeCount: stillActive.length, total: miningIds.length },
        "mining: waiting for miners to finish"
      );
      return;
    }

    // Find an idle manny to do the recovery
    const recoverer = mannies.find(
      (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
    );
    if (!recoverer) {
      logger.info({ label }, "mining: no idle manny for recovery, deferring");
      return;
    }
    claimedMannies.add(recoverer.id as string);

    await c.recoverContainer(recoverer.id as string, containerObjectId);
    logger.info({ label, mannyId: recoverer.id }, "mining: recovery dispatched");

    await updateMiningCycleState(assignment.id, {
      cycleState: "recovering",
      miningMannyIds: [],
    });

  } else if (assignment.cycleState === "recovering") {
    // Check if the container has returned to probe inventory
    const invContainers: any[] = (probe?.inventory?.containers ?? []).filter(
      (c: any) =>
        (typeof c.kind === "string" && c.kind.toLowerCase().includes("container")) ||
        (c.capacity != null && c.capacity > 0)
    );
    const back = invContainers.find((c: any) => c.id === assignment.containerId);
    if (back) {
      logger.info({ label }, "mining: container recovered — cycle complete, resetting to idle");
      await updateMiningCycleState(assignment.id, {
        cycleState: "idle",
        asteroidObjectId: undefined,
        miningMannyIds: [],
        lastCycleAt: new Date().toISOString(),
      });
    }
  }
}

/** Poll all pending actions for one probe. */
async function pollProbe(
  probeId: number | null,
  actions: PendingAction[]
): Promise<void> {
  const c = clientFor(probeId);
  const label = probeId != null ? `probe ${probeId}` : "main probe";

  let probeResp: any = null;
  let manniesResp: any = null;
  try {
    [probeResp, manniesResp] = await Promise.all([c.getProbe(), c.getMannies()]);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (isPermanentFetchError(err)) {
      // The probe can't be reached and won't recover (e.g. it was decommissioned
      // while these rows still targeted it). Fail the rows into the recent view
      // instead of silently retrying a dead probe every 30s forever.
      logger.error(
        { label, err: msg },
        "poller: target probe fetch failed permanently — failing its scheduled rows",
      );
      for (const action of actions) {
        await resolveQuietly(action.id, {
          status: "failed",
          error: `target ${label} unavailable: ${msg}`,
        });
      }
    } else {
      logger.warn(
        { label, err: msg },
        "poller: transient probe fetch failure — retrying next tick",
      );
    }
    return;
  }

  const mannies: any[] = manniesResp?.mannies ?? [];
  const probe = probeResp?.probe ?? null;

  const claimedMannies = new Set<string>();
  let probeMoveClaimed = false;

  // Pre-claim ALL mannies tracked by an active mining/drift assignment so
  // neither the crafting queue nor fill-slots can grab them while they are
  // temporarily idle between tasks.
  const activeMiningAssignments = await getMiningAssignments().catch(() => []);
  for (const a of activeMiningAssignments) {
    if (
      a.enabled &&
      (a.probeId ?? null) === (probeId ?? null) &&
      (a.cycleState === "mining" || a.cycleState === "deploying")
    ) {
      for (const id of a.miningMannyIds ?? []) {
        claimedMannies.add(id);
      }
    }
  }

  // If there are pending crafting/scheduled actions, reserve 25% of total
  // mannies for them so mining never fully starves the crafting queue.
  // Exception: if every crafting attempt last tick returned "insufficient
  // resources", drop the reserve to 0 — all hands go to mining until
  // materials arrive, then the reserve is restored automatically.
  const hasPendingCrafting = actions.some(
    (a) => a.action.type === "craft_item" || a.action.type === "atomic_printer_craft"
  );
  const probeKey = probeId != null ? String(probeId) : "main";
  const craftingBlockedLastTick = craftingMaterialsBlocked.has(probeKey);

  const craftingReserve = hasPendingCrafting && !craftingBlockedLastTick
    ? Math.ceil(mannies.length * 0.25)
    : 0;
  if (craftingReserve > 0) {
    logger.info(
      { craftingReserve, totalMannies: mannies.length },
      "poller: reserving mannies for crafting queue"
    );
  } else if (hasPendingCrafting && craftingBlockedLastTick) {
    logger.info(
      { totalMannies: mannies.length },
      "poller: crafting blocked by missing materials — no reserve, all mannies available for mining"
    );
  }

  // Track crafting outcomes this tick so we can update craftingMaterialsBlocked.
  let craftingAttempts = 0;
  let craftingInsufficientCount = 0;

  // Mining automation runs first — claims mannies before crafting queue can
  await runMiningAutomation(probeId, probe, mannies, claimedMannies, c, craftingReserve).catch((err) =>
    logger.error({ err: err?.message, probeId }, "poller: mining automation error")
  );

  for (const action of actions) {
    let selectedMannyId: string | null = null;

    // ── manny_idle ──────────────────────────────────────────────────────────
    if (action.condition.type === "manny_idle") {
      const cond = action.condition;

      // requireItemsWithQty guard — quantity-aware (preferred)
      if (cond.requireItemsWithQty && cond.requireItemsWithQty.length > 0) {
        const itemCountByType = new Map<string, number>();
        for (const i of probe?.inventory?.items ?? []) {
          const t = i.type as string;
          itemCountByType.set(t, (itemCountByType.get(t) ?? 0) + 1);
        }
        const allSatisfied = cond.requireItemsWithQty.every(
          ({ type, quantity }) => (itemCountByType.get(type) ?? 0) >= quantity
        );
        if (!allSatisfied) {
          const missing = cond.requireItemsWithQty
            .filter(({ type, quantity }) => (itemCountByType.get(type) ?? 0) < quantity)
            .map(({ type, quantity }) => `${type}×${quantity}(have ${itemCountByType.get(type) ?? 0})`);
          logger.info(
            { actionId: action.id, missing, label },
            "poller: required items not yet in inventory — waiting"
          );
          continue;
        }
      }

      // requireItems guard — legacy type-only check (backward compat)
      if (cond.requireItems && cond.requireItems.length > 0) {
        const itemTypes = new Set(
          (probe?.inventory?.items ?? []).map((i: any) => i.type as string)
        );
        const allPresent = cond.requireItems.every((req) => itemTypes.has(req));
        if (!allPresent) {
          logger.info(
            { actionId: action.id, requireItems: cond.requireItems, label },
            "poller: required items not yet in inventory — waiting"
          );
          continue;
        }
      }

      if (cond.mannyId) {
        // Pre-assigned specific Manny
        if (claimedMannies.has(cond.mannyId)) {
          logger.info(
            { actionId: action.id, mannyId: cond.mannyId, label },
            "poller: manny already claimed this cycle — deferring"
          );
          continue;
        }
        const m = mannies.find((m: any) => m.id === cond.mannyId);
        if (!m || m.currentTask) continue;
        selectedMannyId = m.id;
      } else {
        // Any idle Manny on this probe
        const m = mannies.find(
          (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
        );
        if (!m) {
          logger.info(
            { actionId: action.id, label },
            "poller: no idle Manny available — deferring"
          );
          continue;
        }
        selectedMannyId = m.id;
      }

    // ── probe_idle ──────────────────────────────────────────────────────────
    } else if (action.condition.type === "probe_idle") {
      // A probe we couldn't read is not "idle". Without this, a response missing
      // `probe` makes `undefined !== "moving"` true and the action fires blind —
      // e.g. a queued move sent while the probe is already in transit.
      if (!probe) continue;
      if (probe.movement?.status === "moving") continue;
      if (action.action?.type === "move_probe" && probeMoveClaimed) {
        logger.info(
          { actionId: action.id, label },
          "poller: probe move already claimed this cycle — deferring"
        );
        continue;
      }
    }

    logger.info(
      { actionId: action.id, description: action.description, selectedMannyId, label },
      "poller: condition met — executing action"
    );

    const isCraftingAction =
      action.action.type === "craft_item" || action.action.type === "atomic_printer_craft";

    try {
      await executeAction(action, selectedMannyId, c);
      await resolveQuietly(action.id, { status: "triggered" });
      logger.info({ actionId: action.id, label }, "poller: action triggered successfully");

      if (selectedMannyId) claimedMannies.add(selectedMannyId);
      if (action.action.type === "move_probe") probeMoveClaimed = true;
      if (isCraftingAction) craftingAttempts++;  // succeeded — not insufficient
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // 422 "Insufficient resources" — keep pending and retry next cycle
      if (msg.includes("Insufficient resources") || msg.includes("insufficient resources")) {
        logger.info(
          { actionId: action.id, label },
          "poller: insufficient resources — keeping pending, will retry next poll"
        );
        if (isCraftingAction) {
          craftingAttempts++;
          craftingInsufficientCount++;
        }
      } else {
        logger.error({ actionId: action.id, err: msg, label }, "poller: action execution failed");
        await resolveQuietly(action.id, { status: "failed", error: msg });
      }
    }
  }

  // Update the blocked-by-materials flag for the next tick.
  // Blocked = every crafting attempt this tick hit "insufficient resources".
  // Unblocked = at least one succeeded (materials must have arrived).
  if (hasPendingCrafting && craftingAttempts > 0) {
    if (craftingInsufficientCount === craftingAttempts) {
      craftingMaterialsBlocked.add(probeKey);
    } else {
      craftingMaterialsBlocked.delete(probeKey);
    }
  }
}

async function poll(): Promise<void> {
  const [pending, miningAssignments] = await Promise.all([
    getPendingActions(),
    getMiningAssignments().catch(() => [] as Awaited<ReturnType<typeof getMiningAssignments>>),
  ]);

  // Group by probeId — null/undefined both mean "main probe" (key = "main")
  const byProbe = new Map<string, { probeId: number | null; actions: PendingAction[] }>();

  for (const action of pending) {
    const key = action.probeId != null ? String(action.probeId) : "main";
    if (!byProbe.has(key)) byProbe.set(key, { probeId: action.probeId ?? null, actions: [] });
    byProbe.get(key)!.actions.push(action);
  }

  // Also include probes that have active mining assignments (even with no crafting queue)
  for (const ma of miningAssignments) {
    if (!ma.enabled) continue;
    const key = ma.probeId != null ? String(ma.probeId) : "main";
    if (!byProbe.has(key)) byProbe.set(key, { probeId: ma.probeId ?? null, actions: [] });
  }

  if (byProbe.size === 0) return;

  // Poll all probes in parallel
  await Promise.all(
    [...byProbe.values()].map(({ probeId, actions }) =>
      pollProbe(probeId, actions).catch((err) =>
        logger.error({ err, probeId }, "poller: unexpected error for probe")
      )
    )
  );
}

export function startPoller(): void {
  if (started) return;
  started = true;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "poller: started");
  // Reentrancy guard: a tick that runs long — executeAction makes real game
  // calls, and one slow probe holds up its whole group — must not overlap the
  // next one. Two overlapping ticks read the same pending rows (a row is only
  // marked "triggered" after its action lands) and fire them twice. A skipped
  // tick simply retries in POLL_INTERVAL_MS.
  let ticking = false;
  setInterval(() => {
    if (ticking) {
      logger.info("poller: previous tick still running — skipping this one");
      return;
    }
    ticking = true;
    poll()
      .catch((err) => logger.error({ err }, "poller: unexpected error"))
      .finally(() => {
        ticking = false;
      });
  }, POLL_INTERVAL_MS);
}
