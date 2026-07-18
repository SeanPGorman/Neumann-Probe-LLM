import { logger } from "../../lib/logger.js";
import * as client from "./client.js";
import {
  getPendingActions,
  resolvePendingAction,
  type PendingAction,
} from "./file-store.js";

const POLL_INTERVAL_MS = 30_000;
let started = false;

async function executeAction(
  action: PendingAction,
  selectedMannyId: string | null
): Promise<void> {
  const a = action.action;
  // For craft_item the mannyId may have been resolved dynamically
  const mannyId = selectedMannyId ?? (a as any).mannyId as string | undefined;

  switch (a.type) {
    case "move_probe":
      await client.moveProbe(a.x, a.y, a.z);
      break;
    case "craft_item":
      if (!mannyId) throw new Error("craft_item: no Manny selected");
      await client.craftItem(mannyId, a.recipe);
      break;
    case "atomic_printer_craft":
      await client.atomicPrinterCraft(a.recipe);
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

  // Track resources claimed this poll cycle
  const claimedMannies = new Set<string>();
  let probeMoveClaimed = false;

  for (const action of pending) {
    let selectedMannyId: string | null = null;

    // ── manny_idle ────────────────────────────────────────────────────────────
    if (action.condition.type === "manny_idle") {
      const cond = action.condition;

      // 1. requireItems guard — all dependency item types must exist in inventory
      if (cond.requireItems && cond.requireItems.length > 0) {
        const itemTypes = new Set(
          (probe?.inventory?.items ?? []).map((i: any) => i.type as string)
        );
        const allPresent = cond.requireItems.every((req) => itemTypes.has(req));
        if (!allPresent) {
          logger.info(
            { actionId: action.id, requireItems: cond.requireItems, found: [...itemTypes] },
            "poller: required items not yet in inventory — waiting"
          );
          continue;
        }
      }

      // 2. Manny selection
      if (cond.mannyId) {
        // Pre-assigned Manny
        if (claimedMannies.has(cond.mannyId)) {
          logger.info(
            { actionId: action.id, mannyId: cond.mannyId },
            "poller: manny already claimed this cycle — deferring"
          );
          continue;
        }
        const m = mannies.find((m: any) => m.id === cond.mannyId);
        if (!m || m.currentTask) continue;
        selectedMannyId = m.id;
      } else {
        // Any idle Manny — pick the first unclaimed idle one
        const m = mannies.find(
          (m: any) => !m.currentTask && !claimedMannies.has(m.id as string)
        );
        if (!m) {
          logger.info(
            { actionId: action.id },
            "poller: no idle Manny available — deferring"
          );
          continue;
        }
        selectedMannyId = m.id;
      }

    // ── probe_idle ────────────────────────────────────────────────────────────
    } else if (action.condition.type === "probe_idle") {
      if (probe?.movement?.status === "moving") continue;
      if (action.action.type === "move_probe" && probeMoveClaimed) {
        logger.info(
          { actionId: action.id },
          "poller: probe move already claimed this cycle — deferring"
        );
        continue;
      }
    }

    logger.info(
      { actionId: action.id, description: action.description, selectedMannyId },
      "poller: condition met — executing action"
    );

    try {
      await executeAction(action, selectedMannyId);
      await resolvePendingAction(action.id, { status: "triggered" });
      logger.info({ actionId: action.id }, "poller: action triggered successfully");

      if (selectedMannyId) claimedMannies.add(selectedMannyId);
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
