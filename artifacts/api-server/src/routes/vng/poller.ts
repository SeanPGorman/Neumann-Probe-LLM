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
      await runMiningCycle(assignment, probe, mannies, claimedMannies, c, asteroids, sectorObjects);
    } catch (err: any) {
      // 409 = manny busy; defer silently without marking lastError
      if (err instanceof VngApiError && err.status === 409) {
        logger.info({ assignmentId: assignment.id }, "mining: manny busy (409), deferring");
        return;
      }
      logger.error(
        { assignmentId: assignment.id, err: err.message },
        "mining: cycle error"
      );
      await updateMiningCycleState(assignment.id, { lastError: err.message }).catch(() => {});
    }
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
): Promise<void> {
  const label = `mining assignment ${assignment.id} (${assignment.material})`;

  if (assignment.cycleState === "idle") {
    // Container must be in probe inventory
    const invContainers: any[] = (probe?.inventory?.containers ?? []).filter(
      (c: any) => c.kind === "container"
    );
    const container = invContainers.find((c: any) => c.id === assignment.containerId);
    if (container && (container.usedCapacity ?? 0) > 0) {
      logger.info({ label, usedCapacity: container.usedCapacity }, "mining: container not empty yet — waiting for unload");
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

    // Claim N idle mannies (unclaimed, no currentTask)
    const available = mannies.filter(
      (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
    );
    if (available.length < assignment.mannyCount) {
      logger.info(
        { label, need: assignment.mannyCount, have: available.length },
        "mining: not enough idle mannies, deferring"
      );
      return;
    }
    const selected = available.slice(0, assignment.mannyCount);
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

    // 2. All N mannies mine 1/N of capacity into the container
    for (const m of selected) {
      await c.mineResources(
        m.id as string,
        asteroid.id as string,
        [assignment.material],
        perManny,
        containerObjectId
      );
    }
    logger.info(
      { label, mannyCount: selected.length, perManny },
      "mining: mine tasks dispatched"
    );

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

    const stillNeeded = assignment.mannyCount - miningIds.length;
    if (stillNeeded > 0 && effectiveAsteroidId) {
      const extraAvailable = mannies.filter(
        (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
      );
      if (extraAvailable.length > 0) {
        const toAdd = extraAvailable.slice(0, stillNeeded);
        // Use stored capacity; fall back to sector object when assignment was
        // created before this field was introduced.
        const cap: number =
          assignment.containerCapacity ??
          (deployedContainerObj?.capacity as number | undefined) ??
          1;
        const perManny = cap / assignment.mannyCount;
        const containerObjectId = toSectorObjectId(assignment.containerId);
        for (const m of toAdd) {
          await c.mineResources(
            m.id as string,
            effectiveAsteroidId,
            [assignment.material],
            perManny,
            containerObjectId
          );
          claimedMannies.add(m.id as string);
        }
        miningIds = [...miningIds, ...toAdd.map((m: any) => m.id as string)];
        await updateMiningCycleState(assignment.id, {
          miningMannyIds: miningIds,
          containerCapacity: cap,
          asteroidObjectId: effectiveAsteroidId, // persist for future ticks
        });
        logger.info(
          { label, added: toAdd.length, total: miningIds.length },
          "mining: filled remaining manny slots"
        );
      }
    }

    // Classify each tracked manny: still mining for us | done/idle | stale (different task)
    //
    // "Mining for us" means the manny's raw task targets our asteroid or our
    // deployed container.  We check task.objectId (asteroid) and
    // task.targetContainerId (deposit target) from the raw game API response.
    // String-matching on currentTask is unreliable because "mine".includes("mine")
    // is true but "mining".includes("mine") is FALSE — "mine"≠substring of "mining".
    const containerSectorId = toSectorObjectId(assignment.containerId);
    const effectiveAsteroidForCheck =
      assignment.asteroidObjectId ??
      rawSectorObjects.find((o: any) => o.id === containerSectorId)?.targetObjectId as string | undefined;

    const stillMining: string[] = [];
    const staleIds: string[] = [];
    for (const id of miningIds) {
      const m = mannies.find((m: any) => m.id === id);
      if (!m || !m.currentTask) continue; // idle or not found — treat as done

      // Check by raw task objectId/targetContainerId when available (most reliable).
      const taskObj: any = m.task && typeof m.task === "object" ? m.task : null;
      const taskTargetContainer: string | undefined = taskObj?.targetContainerId;
      const taskAsteroid: string | undefined = taskObj?.objectId;

      // String-based fallback — note: "mine" is NOT a substring of "mining"
      // ("min-e" vs "min-i-ng"), so use a regex that matches both forms.
      const taskStr = String(m.currentTask ?? "").toLowerCase();
      const isMiningTaskName = /^min(e|ing)/.test(taskStr);

      const isMiningForUs =
        isMiningTaskName ||
        taskTargetContainer === containerSectorId ||
        (!!effectiveAsteroidForCheck && taskAsteroid === effectiveAsteroidForCheck);

      if (isMiningForUs) {
        stillMining.push(id);
      } else {
        // Manny's task points elsewhere — stale entry, do not block recovery.
        staleIds.push(id);
        logger.info(
          { label, mannyId: id, task: m.currentTask, taskAsteroid, taskTargetContainer },
          "mining: manny task targets different object — removing from cycle"
        );
      }
    }
    // Persist the cleaned-up list so we don't re-evaluate stale mannies
    if (staleIds.length > 0) {
      miningIds = miningIds.filter((id) => !staleIds.includes(id));
      await updateMiningCycleState(assignment.id, { miningMannyIds: miningIds });
    }

    if (stillMining.length > 0) {
      logger.info(
        { label, busyCount: stillMining.length, total: miningIds.length },
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

    const containerObjectId = toSectorObjectId(assignment.containerId);
    await c.recoverContainer(recoverer.id as string, containerObjectId);
    logger.info({ label, mannyId: recoverer.id }, "mining: recovery dispatched");

    await updateMiningCycleState(assignment.id, {
      cycleState: "recovering",
      miningMannyIds: [],
    });

  } else if (assignment.cycleState === "recovering") {
    // Check if the container has returned to probe inventory
    const invContainers: any[] = (probe?.inventory?.containers ?? []).filter(
      (c: any) => c.kind === "container"
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

  // Pre-claim mannies that are ACTIVELY busy on a mining task so the crafting
  // queue cannot steal them mid-cycle.  Only claim mannies that still have a
  // currentTask — once they go idle they become candidates for the recovery
  // dispatch and must not remain claimed.
  const activeMiningAssignments = await getMiningAssignments().catch(() => []);
  for (const a of activeMiningAssignments) {
    if (
      a.enabled &&
      (a.probeId ?? null) === (probeId ?? null) &&
      a.cycleState !== "idle"
    ) {
      for (const id of a.miningMannyIds ?? []) {
        const m = mannies.find((m: any) => m.id === id);
        if (m?.currentTask) claimedMannies.add(id);
      }
    }
  }

  // Mining automation runs first — claims mannies before crafting queue can
  await runMiningAutomation(probeId, probe, mannies, claimedMannies, c).catch((err) =>
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

    try {
      await executeAction(action, selectedMannyId, c);
      await resolveQuietly(action.id, { status: "triggered" });
      logger.info({ actionId: action.id, label }, "poller: action triggered successfully");

      if (selectedMannyId) claimedMannies.add(selectedMannyId);
      if (action.action.type === "move_probe") probeMoveClaimed = true;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // 422 "Insufficient resources" — keep pending and retry next cycle
      if (msg.includes("Insufficient resources") || msg.includes("insufficient resources")) {
        logger.info(
          { actionId: action.id, label },
          "poller: insufficient resources — keeping pending, will retry next poll"
        );
      } else {
        logger.error({ actionId: action.id, err: msg, label }, "poller: action execution failed");
        await resolveQuietly(action.id, { status: "failed", error: msg });
      }
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
