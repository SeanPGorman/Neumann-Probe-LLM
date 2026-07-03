import { logger } from "../../lib/logger.js";
import * as client from "./client.js";
import {
  getPendingActions,
  resolvePendingAction,
  type PendingAction,
} from "./file-store.js";

const POLL_INTERVAL_MS = 30_000;
let started = false;

async function checkCondition(
  action: PendingAction,
  mannies: any[],
  probe: any
): Promise<boolean> {
  const cond = action.condition;
  if (cond.type === "manny_idle") {
    const m = mannies.find((m: any) => m.id === cond.mannyId);
    return m ? !m.currentTask : false;
  }
  if (cond.type === "probe_idle") {
    return probe?.movement?.status !== "moving";
  }
  return false;
}

async function executeAction(action: PendingAction): Promise<void> {
  const a = action.action;
  switch (a.type) {
    case "move_probe":
      await client.moveProbe(a.x, a.y, a.z);
      break;
    case "craft_item":
      await client.craftItem(a.mannyId, a.recipe);
      break;
    case "mine_resources":
      await client.mineResources(
        a.mannyId,
        a.objectId,
        a.resources,
        a.targetAmount,
        a.targetContainerId
      );
      break;
    case "detach_container":
      await client.detachContainer(a.mannyId, a.containerId);
      break;
    case "recover_container":
      await client.recoverContainer(a.mannyId, a.objectId);
      break;
    default:
      throw new Error(`Unknown action type`);
  }
}

/** Return the manny ID that an action will occupy, if any. */
function actionMannyId(action: PendingAction): string | null {
  const a = action.action;
  if (
    a.type === "craft_item" ||
    a.type === "mine_resources" ||
    a.type === "detach_container" ||
    a.type === "recover_container"
  ) {
    return a.mannyId;
  }
  return null;
}

async function poll(): Promise<void> {
  const pending = await getPendingActions();
  if (pending.length === 0) return;

  let probeResp: any = null;
  let manniesResp: any = null;
  try {
    [probeResp, manniesResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
    ]);
  } catch (err) {
    logger.warn({ err }, "poller: failed to fetch probe state");
    return;
  }

  const mannies: any[] = manniesResp?.mannies ?? [];
  const probe = probeResp?.probe ?? null;

  // Track mannies and singleton resources claimed this cycle so we only fire
  // one action per manny (and one probe-move) per poll tick.
  const claimedMannies = new Set<string>();
  let probeMoveClaimed = false;

  for (const action of pending) {
    // Check if the resource this action needs is already claimed this cycle
    const mannyId = actionMannyId(action);
    if (mannyId && claimedMannies.has(mannyId)) {
      logger.info(
        { actionId: action.id, mannyId },
        "poller: manny already claimed this cycle — deferring to next tick"
      );
      continue;
    }
    if (action.action.type === "move_probe" && probeMoveClaimed) {
      logger.info(
        { actionId: action.id },
        "poller: probe move already claimed this cycle — deferring"
      );
      continue;
    }

    let conditionMet = false;
    try {
      conditionMet = await checkCondition(action, mannies, probe);
    } catch (err) {
      logger.warn({ err, actionId: action.id }, "poller: condition check error");
      continue;
    }

    if (!conditionMet) continue;

    logger.info(
      { actionId: action.id, description: action.description },
      "poller: condition met — executing action"
    );

    try {
      await executeAction(action);
      await resolvePendingAction(action.id, { status: "triggered" });
      logger.info({ actionId: action.id }, "poller: action triggered successfully");

      // Mark the resource as claimed so subsequent actions skip this cycle
      if (mannyId) claimedMannies.add(mannyId);
      if (action.action.type === "move_probe") probeMoveClaimed = true;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      logger.error({ actionId: action.id, err: msg }, "poller: action execution failed");
      await resolvePendingAction(action.id, { status: "failed", error: msg });
    }
  }
}

export function startPoller(): void {
  if (started) return;
  started = true;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "poller: started");
  setInterval(() => {
    poll().catch((err) => logger.error({ err }, "poller: unexpected error"));
  }, POLL_INTERVAL_MS);
}
