import { logger } from "../../lib/logger.js";
import { clientFor } from "./client.js";
import {
  getPendingActions,
  resolvePendingAction,
  type PendingAction,
} from "./file-store.js";

const POLL_INTERVAL_MS = 30_000;
let started = false;

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
    default:
      throw new Error(`Unknown action type`);
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
  } catch (err) {
    logger.warn({ err, label }, "poller: failed to fetch probe state");
    return;
  }

  const mannies: any[] = manniesResp?.mannies ?? [];
  const probe = probeResp?.probe ?? null;

  const claimedMannies = new Set<string>();
  let probeMoveClaimed = false;

  for (const action of actions) {
    let selectedMannyId: string | null = null;

    // ── manny_idle ──────────────────────────────────────────────────────────
    if (action.condition.type === "manny_idle") {
      const cond = action.condition;

      // requireItems guard
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
      if (probe?.movement?.status === "moving") continue;
      if (action.action.type === "move_probe" && probeMoveClaimed) {
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
      await resolvePendingAction(action.id, { status: "triggered" });
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
        await resolvePendingAction(action.id, { status: "failed", error: msg });
      }
    }
  }
}

async function poll(): Promise<void> {
  const pending = await getPendingActions();
  if (pending.length === 0) return;

  // Group by probeId — null/undefined both mean "main probe" (key = "main")
  const byProbe = new Map<string, { probeId: number | null; actions: PendingAction[] }>();
  for (const action of pending) {
    const key = action.probeId != null ? String(action.probeId) : "main";
    if (!byProbe.has(key)) {
      byProbe.set(key, { probeId: action.probeId ?? null, actions: [] });
    }
    byProbe.get(key)!.actions.push(action);
  }

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
  setInterval(() => {
    poll().catch((err) => logger.error({ err }, "poller: unexpected error"));
  }, POLL_INTERVAL_MS);
}
