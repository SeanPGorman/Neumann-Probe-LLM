import { Router } from "express";
import OpenAI from "openai";
import * as client from "./client.js";
import { TOOLS, executeTool } from "./tools.js";

const router = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

function sse(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.get("/state", async (_req, res) => {
  try {
    const [probeResp, manniesResp, sectorResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
      client.getSector(),
    ]);

    const probe = probeResp.probe;
    const inv = probe.inventory ?? {};
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };

    const mannies = (manniesResp.mannies ?? []).map((m: any) => ({
      id: m.id,
      name: m.name,
      currentTask: m.currentTask,
      taskProgressPercent: m.taskProgressPercent,
      taskEstimatedEndTime: m.taskEstimatedEndTime ?? null,
      location: m.location ?? null,
    }));

    const sectorObjects = (sectorResp.sector?.objects ?? []).map((o: any) => ({
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
      sectorObjects,
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

    const [probeResp, manniesResp, sectorResp, recipesResp] =
      await Promise.all([
        client.getProbe(),
        client.getMannies(),
        client.getSector(),
        client.getCraftingRecipes(),
      ]);

    const probe = probeResp.probe;
    const mannies: any[] = manniesResp.mannies ?? [];
    const sectorObjects: any[] = sectorResp.sector?.objects ?? [];
    const recipes: any[] = recipesResp.recipes ?? [];
    const inv = probe.inventory ?? {};
    const inventoryItems: any[] = inv.items ?? [];
    const resourceStocks: any[] = inv.resourceStocks ?? [];
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };

    const idlemannies = mannies.filter((m: any) => !m.currentTask);
    const busyMannies = mannies.filter((m: any) => m.currentTask);

    const asteroids = sectorObjects.filter(
      (o: any) => o.type === "asteroid" && o.id
    );
    const containers = inventoryItems.filter(
      (i: any) => i.type === "storage_container"
    );

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

== MANNIES (${mannies.length} total) ==
IDLE (${idlemannies.length}):
${idlemannies.map((m: any) => `  • ${m.name}  id="${m.id}"`).join("\n") || "  none"}
BUSY (${busyMannies.length}):
${busyMannies.map((m: any) => `  • ${m.name}  id="${m.id}"  task=${m.currentTask}  progress=${m.taskProgressPercent?.toFixed(1)}%  eta=${m.taskEstimatedEndTime ?? "?"}`).join("\n") || "  none"}

== SECTOR OBJECTS (${sectorObjects.length}) ==
${sectorObjects.slice(0, 30).map((o: any) => `  • [${o.type}] "${o.name ?? "unnamed"}"  id="${o.id ?? "none"}"  ${o.resourceTypes?.length ? `resources=[${o.resourceTypes.join(",")}]  ` : ""}${o.summary ?? ""}`).join("\n") || "  none"}

== INVENTORY ==
Capacity: ${(inv.usedCapacity ?? 0).toFixed(3)} / ${inv.capacity ?? 0} ECE used  (${(inv.freeCapacity ?? 0).toFixed(3)} free)
Resources: ${resourceStocks.map((s: any) => `${s.name}=${s.amount}`).join(", ") || "none"}
Storage containers aboard: ${containers.map((c: any) => `"${c.name}"  id="${c.id}"`).join(", ") || "none"}
Other items: ${inventoryItems.filter((i: any) => i.type !== "manny" && i.type !== "atomic_3d_printer" && i.type !== "storage_container").map((i: any) => `${i.name}(${i.type})`).join(", ") || "none"}

== CRAFTING RECIPES (use 'get_game_state' if you need full details) ==
${recipes.slice(0, 20).map((r: any) => `  • ${r.id} — "${r.name}"  craftableBy=[${(r.craftableBy ?? []).join(",")}]  duration=${r.durationSeconds}s`).join("\n")}

== RULES ==
- Manny IDs are long strings like "mny_e84fa37181de693e8e831147" — use the exact IDs shown above.
- Always use get_game_state to refresh data if you need IDs that aren't visible above.
- Only use IDs from real data — never invent them.
- Mining, crafting, and salvage are long-running tasks — once started the Manny is busy for real game time. Tell the operator the task has been QUEUED, not finished.
- For multi-step tasks (e.g. craft container → detach it → mine into it), execute sequentially; call get_game_state after each step to confirm IDs before the next.
- Be concise and precise. State what you did and what the operator should expect.`;

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
        try {
          result = await executeTool(toolName, args);
          sse(res, {
            type: "result",
            tool: toolName,
            id: call.id,
            success: true,
            data: result,
          });
        } catch (err: any) {
          result = { error: err.message };
          sse(res, {
            type: "result",
            tool: toolName,
            id: call.id,
            success: false,
            error: err.message,
          });
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
