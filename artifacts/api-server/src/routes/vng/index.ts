import { Router } from "express";
import OpenAI from "openai";
import * as client from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import {
  addContainer,
  cancelPendingAction,
  markContainerRecovered,
  recordSector,
  toSectorObjectId,
  updateContainerAnchor,
  getFloatingContainers,
  getPendingActions,
} from "./file-store.js";

const router = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

function sse(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.get("/scheduled", async (_req, res) => {
  try {
    const actions = await getPendingActions();
    res.json({ actions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/scheduled/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await cancelPendingAction(id);
    if (ok) res.json({ ok: true });
    else res.status(404).json({ error: `No pending action with id ${id}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/state", async (_req, res) => {
  try {
    const [probeResp, manniesResp, sectorResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
      client.getSector().catch(() => null),  // unavailable during high-speed transit
    ]);

    const probe = probeResp.probe;
    const inv = probe.inventory ?? {};
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };
    const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];

    recordSector(sector.x, sector.y, sector.z, sectorObjects).catch(() => {});

    const mannies = (manniesResp.mannies ?? []).map((m: any) => ({
      id: m.id,
      name: m.name,
      currentTask: m.currentTask,
      taskProgressPercent: m.taskProgressPercent,
      taskEstimatedEndTime: m.taskEstimatedEndTime ?? null,
      location: m.location ?? null,
    }));

    const activeMannyIds = new Set((manniesResp.mannies ?? []).map((m: any) => m.id));
    const stowedMannies = ((probeResp.probe?.inventory?.items ?? []) as any[])
      .filter((i: any) => i.type === "manny" && !activeMannyIds.has(i.id))
      .map((i: any) => ({ itemId: i.id, name: i.label ?? i.name ?? "Unnamed Manny" }));

    const sectorObjectsMapped = sectorObjects.map((o: any) => ({
      id: o.id ?? null,
      type: o.type,
      name: o.name ?? null,
      summary: o.summary,
      resourceTypes: o.resourceTypes ?? [],
    }));

    res.json({
      probe: {
        id: probe.id,
        name: probe.name,
        status: probe.status,
        fuelDeuterium: probe.fuel?.deuterium ?? 0,
        integrityPercent: probe.systems?.integrityPercent ?? 0,
        sector,
        movement: probe.movement ?? null,
      },
      inventory: {
        capacity: inv.capacity ?? 0,
        usedCapacity: inv.usedCapacity ?? 0,
        freeCapacity: inv.freeCapacity ?? 0,
      },
      mannies,
      stowedMannies,
      sectorObjects: sectorObjectsMapped,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/command", async (req, res) => {
  const { command } = req.body as { command: string };

  if (!command?.trim()) {
    res.status(400).json({ error: "command is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    sse(res, { type: "status", message: "Fetching current probe state…" });

    const [probeResp, manniesResp, sectorResp, recipesResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
      client.getSector().catch(() => null),  // unavailable during relativistic transit
      client.getCraftingRecipes(),
    ]);

    const probe = probeResp.probe;
    const mannies: any[] = manniesResp.mannies ?? [];
    const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];
    const recipes: any[] = recipesResp.recipes ?? [];
    const inv = probe.inventory ?? {};
    const inventoryItems: any[] = inv.items ?? [];
    const resourceStocks: any[] = inv.resourceStocks ?? [];
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };

    recordSector(sector.x, sector.y, sector.z, sectorObjects).catch(() => {});

    const manniesById = new Map(mannies.map((m: any) => [m.id, m]));
    const itemsById = new Map(inventoryItems.map((i: any) => [i.id, i]));

    const idleMannies = mannies.filter((m: any) => !m.currentTask);
    const busyMannies = mannies.filter((m: any) => m.currentTask);

    // All containers registered on the probe (no kind filter — we show everything)
    const boardedContainers = inv.containers ?? [];
    const containersById = new Map(boardedContainers.map((c: any) => [c.id, c]));

    // All inventory items that are not mannies or the atomic printer
    const nonMannyItems = inventoryItems.filter(
      (i: any) => i.type !== "manny" && i.type !== "atomic_3d_printer"
    );

    // Mannies sitting in inventory (not yet deployed / activated) — exclude already-active ones
    const activeMannyIdSet = new Set(mannies.map((m: any) => m.id));
    const stowedMannies = inventoryItems.filter((i: any) => i.type === "manny" && !activeMannyIdSet.has(i.id));

    // Pull tracked floating containers for this sector
    const trackedFloating = await getFloatingContainers(sector.x, sector.y, sector.z);

    // Cross-reference sector objects for detached containers
    const sectorDetached = sectorObjects.filter((o: any) => o.type === "detached_container");
    const sectorDetachedById = new Map(sectorDetached.map((o: any) => [o.id, o]));

    // Build a floating container summary with all needed IDs
    const floatingContainerLines = trackedFloating.map((c) => {
      const sectorObj = sectorDetachedById.get(c.sectorObjectId);
      const anchor = sectorObj?.targetObjectId ?? c.anchorObjectId;
      const anchorName = c.anchorObjectName ?? (anchor ? `object id="${anchor}"` : "unknown");
      return `  • "${c.containerName}"
      SECTOR OBJECT ID (use for target_container_id or object_id): "${c.sectorObjectId}"
      Anchor: ${anchorName}${anchor ? `  anchor_id="${anchor}"` : ""}
      Detached by: ${c.mannyName} on ${new Date(c.detachedAt).toISOString()}`;
    });

    // Untracked detached containers also visible in sector
    const trackedSectorIds = new Set(trackedFloating.map((c) => c.sectorObjectId));
    const untrackedDetached = sectorDetached.filter((o: any) => !trackedSectorIds.has(o.id));

    const systemPrompt = `You are the AI operator of Von Neumann Probe #${probe.id} ("${probe.name}").
Your job is to carry out the operator's instructions by calling the provided tools.

== CURRENT STATE ==
Status: ${probe.status}
Fuel (deuterium): ${(probe.fuel?.deuterium ?? 0).toFixed(2)} ECE
Hull integrity: ${(probe.systems?.integrityPercent ?? 0).toFixed(1)}%
Current sector: x=${sector.x}, y=${sector.y}, z=${sector.z}
Movement: ${
      probe.movement?.status === "moving"
        ? `moving to (${probe.movement.target?.x},${probe.movement.target?.y},${probe.movement.target?.z}), arrives ${probe.movement.arrivalAt}`
        : "stationary"
    }

== MANNIES (${mannies.length} active, ${stowedMannies.length} stowed) ==
IDLE (${idleMannies.length}):
${idleMannies.map((m: any) => `  • ${m.name}  id="${m.id}"`).join("\n") || "  none"}
BUSY (${busyMannies.length}):
${busyMannies.map((m: any) => `  • ${m.name}  id="${m.id}"  task=${m.currentTask}  progress=${m.taskProgressPercent?.toFixed(1)}%  eta=${m.taskEstimatedEndTime ?? "?"}`).join("\n") || "  none"}
STOWED IN INVENTORY (${stowedMannies.length}) — call deploy_manny to activate:
${stowedMannies.map((m: any) => `  • ${m.label ?? m.name ?? "Unnamed Manny"}  item_id="${m.id}"`).join("\n") || "  none"}

== SECTOR OBJECTS (${sectorObjects.length}) ==
${sectorObjects
  .filter((o: any) => o.type !== "detached_container")
  .slice(0, 25)
  .map((o: any) => `  • [${o.type}] "${o.name ?? "unnamed"}"  id="${o.id ?? "none"}"  ${o.resourceTypes?.length ? `resources=[${o.resourceTypes.join(",")}]  ` : ""}${o.summary ?? ""}`)
  .join("\n") || "  none"}

== FLOATING STORAGE CONTAINERS IN THIS SECTOR ==
IMPORTANT: These containers are floating in the current sector (or anchored to nearby asteroids).
Use the SECTOR OBJECT ID when directing mining output (target_container_id) or recovering them (object_id).
${
  floatingContainerLines.length > 0
    ? floatingContainerLines.join("\n")
    : "  none tracked"
}
${
  untrackedDetached.length > 0
    ? `\nADDITIONAL (untracked) detached containers visible in sector:\n` +
      untrackedDetached
        .map((o: any) => `  • "${o.name ?? "unnamed"}"  SECTOR OBJECT ID="${o.id}"  capacity=${o.capacity}ECE${o.targetObjectId ? `  anchored to object="${o.targetObjectId}"` : ""}`)
        .join("\n")
    : ""
}

== CONTAINERS ABOARD PROBE ==
${boardedContainers.map((c: any) => `  • "${c.label ?? c.name ?? c.id}"  inventory_id="${c.id}"  kind="${c.kind ?? "?"}"  capacity=${c.capacity ?? "?"}ECE  used=${(c.usedCapacity ?? 0).toFixed(2)}ECE  free=${(c.freeCapacity ?? 0).toFixed(2)}ECE  (once detached → sector_object_id will be "detached-container-${c.id}")`).join("\n") || "  none"}

== INVENTORY ITEMS (excluding mannies and atomic printer) ==
${nonMannyItems.map((i: any) => `  • "${i.label ?? i.name ?? i.id}"  inventory_id="${i.id}"  type="${i.type ?? "?"}"`).join("\n") || "  none"}

== INVENTORY ==
Capacity: ${(inv.usedCapacity ?? 0).toFixed(3)} / ${inv.capacity ?? 0} ECE used  (${(inv.freeCapacity ?? 0).toFixed(3)} free)
Resources: ${resourceStocks.map((s: any) => `${s.name}=${s.amount}`).join(", ") || "none"}

== CRAFTING RECIPES ==
${recipes.slice(0, 20).map((r: any) => `  • ${r.id} — "${r.name}"  craftableBy=[${(r.craftableBy ?? []).join(",")}]  duration=${r.durationSeconds}s`).join("\n")}

== SCHEDULED ACTIONS (pending — poller will execute these automatically) ==
${
  (await getPendingActions())
    .map((a) => {
      const cond = a.condition.type === "manny_idle"
        ? `when ${a.condition.mannyName} (${a.condition.mannyId}) is idle`
        : `when probe is idle`;
      return `  • #${a.id} "${a.description}" — ${cond}`;
    })
    .join("\n") || "  none"
}

== RULES ==
- Manny IDs are long strings like "mny_e84fa37181de693e8e831147" — use exact IDs from above.
- For mining into a floating container: use the SECTOR OBJECT ID (not the inventory ID) as target_container_id.
- For recovering a container: use the SECTOR OBJECT ID as object_id.
- Detached containers are often "hidden on asteroid" (anchored to an asteroid). This is normal — you can still mine into them or recover them using the sector object ID.
- Always use get_game_state to refresh if you need IDs not listed above.
- Never invent IDs — only use IDs from real data.
- Mining, crafting, and salvage are long-running tasks — once started the Manny is busy for real game time. Tell the operator the task has been QUEUED.
- For multi-step tasks, execute sequentially; call get_game_state after each step to confirm IDs.
- When the operator says "when X finishes, do Y" or "once X is done, do Y" — use schedule_action. Always confirm the scheduled action ID after creating it.
- PARALLEL BUILDS: When asked to build a complex item, assign independent sub-component chains to different mannies simultaneously. Example for a Linear Actuator: assign Manny A to craft steel_bar→steel_bar→steel_plate→electric_motor (sequential chain), assign Manny B to pre-craft steel_bar→steel_plate→steel_plate (the parts the actuator needs beyond the motor). Schedule the final linear_actuator assembly on either manny with condition requireItems=["electric_motor"] so it only fires once the motor is in inventory — even if that manny finishes their chain first.
- DEPENDENCY GUARD: Use requireItems in the schedule_action condition whenever a step depends on an item being produced by a *different* manny in parallel. Without it, the step could fire before its dependency is ready.
- Be concise and precise.`;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: command },
    ];

    sse(res, { type: "status", message: "AI thinking…" });

    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const completion = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      });

      const msg = completion.choices[0].message;
      messages.push(msg);

      if (msg.content) {
        sse(res, { type: "message", content: msg.content });
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        break;
      }

      for (const call of msg.tool_calls) {
        const toolName = call.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }

        sse(res, { type: "action", tool: toolName, params: args, id: call.id });

        let result: unknown;
        let success = false;
        try {
          result = await executeTool(toolName, args);
          success = true;
          sse(res, { type: "result", tool: toolName, id: call.id, success: true, data: result });
        } catch (err: any) {
          result = { error: err.message };
          sse(res, { type: "result", tool: toolName, id: call.id, success: false, error: err.message });
        }

        if (success) {
          if (toolName === "detach_container") {
            const mannyId = args.manny_id as string;
            const containerId = args.container_id as string;
            const mannyInfo = manniesById.get(mannyId);
            const itemInfo = containersById.get(containerId) ?? itemsById.get(containerId);
            const sectorObjectId = toSectorObjectId(containerId);

            const record = await addContainer({
              containerId,
              sectorObjectId,
              containerName: itemInfo?.label ?? itemInfo?.name ?? containerId,
              mannyId,
              mannyName: mannyInfo?.name ?? mannyId,
              sectorX: sector.x,
              sectorY: sector.y,
              sectorZ: sector.z,
              status: "floating",
              anchorObjectId: null,
              anchorObjectName: null,
              notes: null,
            });

            // Refresh sector to find the anchor asteroid this container attached to
            client.getSector().then((freshSector) => {
              const freshObj = (freshSector.sector?.objects ?? []).find(
                (o: any) => o.id === sectorObjectId
              );
              if (freshObj?.targetObjectId) {
                const anchorObj = (freshSector.sector?.objects ?? []).find(
                  (o: any) => o.id === freshObj.targetObjectId
                );
                updateContainerAnchor(
                  record.id,
                  freshObj.targetObjectId,
                  anchorObj?.name ?? null
                ).catch(() => {});
              }
            }).catch(() => {});
          }

          if (toolName === "recover_container") {
            markContainerRecovered(args.object_id as string).catch(() => {});
          }

          if (toolName === "scan_sector") {
            const scannedObjects: any[] = (result as any)?.sector?.objects ?? [];
            recordSector(args.x as number, args.y as number, args.z as number, scannedObjects).catch(() => {});
          }

          if (toolName === "get_game_state") {
            const gs = result as any;
            const gsObjects = gs?.sector?.objects ?? [];
            const gsSector = gs?.probe?.sector ?? sector;
            recordSector(gsSector.x, gsSector.y, gsSector.z, gsObjects).catch(() => {});
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    sse(res, { type: "done" });
  } catch (err: any) {
    sse(res, { type: "error", message: err.message });
    sse(res, { type: "done" });
  } finally {
    res.end();
  }
});

export default router;
