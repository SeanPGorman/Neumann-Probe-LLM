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

router.get("/state", async (req, res) => {
  try {
    const [probeResp, manniesResp, sectorResp, recipesResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
      client.getSector(),
      client.getCraftingRecipes(),
    ]);

    const probe = probeResp.probe;
    const mannies = (manniesResp.mannies ?? []).map((m: any) => ({
      id: m.id,
      name: m.name,
      currentTask: m.currentTask,
      taskProgressPercent: m.taskProgressPercent,
      integrity: m.integrity,
      location: m.location ?? null,
    }));

    const sectorObjects = (sectorResp.sector?.objects ?? []).map((o: any) => ({
      id: o.id ?? null,
      type: o.type,
      name: o.name ?? null,
      summary: o.summary,
      resourceTypes: o.resourceTypes ?? [],
    }));

    const recipes = (recipesResp.recipes ?? []).map((r: any) =>
      typeof r === "string" ? r : r.recipe ?? r.name ?? String(r)
    );

    res.json({
      probe: {
        id: probe.id,
        name: probe.name,
        status: probe.status,
        fuelPercent: probe.fuelPercent ?? probe.fuel_percent ?? 0,
        integrityPercent: probe.integrityPercent ?? probe.integrity_percent ?? 0,
        sector: probe.sector ?? { relative: { x: 0, y: 0, z: 0 } },
      },
      mannies,
      sectorObjects,
      recipes,
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

    const [probeResp, manniesResp, sectorResp, inventoryResp, recipesResp] =
      await Promise.all([
        client.getProbe(),
        client.getMannies(),
        client.getSector(),
        client.getInventory(),
        client.getCraftingRecipes(),
      ]);

    const probe = probeResp.probe;
    const mannies = manniesResp.mannies ?? [];
    const sectorObjects = sectorResp.sector?.objects ?? [];
    const inventory = inventoryResp.inventory;
    const recipes = recipesResp.recipes ?? [];

    const systemPrompt = `You are the AI operator of Von Neumann Probe #${probe.id} ("${probe.name}").
Your job is to carry out the operator's instructions by calling the provided tools against the game API.

CURRENT STATE:
Probe status: ${probe.status}
Fuel: ${probe.fuelPercent ?? probe.fuel_percent ?? "?"}%
Integrity: ${probe.integrityPercent ?? probe.integrity_percent ?? "?"}%
Current sector (relative): x=${probe.sector?.relative?.x ?? 0}, y=${probe.sector?.relative?.y ?? 0}, z=${probe.sector?.relative?.z ?? 0}
Movement: ${probe.movement ? `moving to ${JSON.stringify(probe.movement.destination)}, arrives ${probe.movement.arrivalAt}` : "stationary"}

MANNIES (${mannies.length}):
${mannies.map((m: any) => `  - Manny #${m.id} "${m.name}": ${m.currentTask ? `busy (${m.currentTask}, ${m.taskProgressPercent}%)` : "IDLE"}, integrity ${m.integrity}%`).join("\n") || "  None"}

SECTOR OBJECTS (${sectorObjects.length}):
${sectorObjects.slice(0, 20).map((o: any) => `  - ${o.type} "${o.name ?? "unnamed"}" id=${o.id ?? "n/a"}: ${o.summary}${o.resourceTypes?.length ? ` [resources: ${o.resourceTypes.join(", ")}]` : ""}`).join("\n") || "  None visible"}

INVENTORY CAPACITY: ${inventory?.freeCapacity ?? "?"}/${inventory?.capacity ?? "?"} free
INVENTORY ITEMS: ${(inventory?.items ?? []).map((i: any) => `${i.name} (${i.type})`).join(", ") || "none"}
INVENTORY RESOURCES: ${(inventory?.resourceStocks ?? []).map((s: any) => `${s.name}: ${s.amount}`).join(", ") || "none"}
INVENTORY CONTAINERS: ${(inventory?.containers ?? []).map((c: any) => `${c.label} id=${c.id}`).join(", ") || "none"}

AVAILABLE CRAFTING RECIPES: ${Array.isArray(recipes) ? recipes.join(", ") : "unknown"}

RULES:
- Always call get_game_state first if you need fresh data about IDs or current tasks.
- Only use tool arguments from real data — never invent object IDs.
- For multi-step tasks (craft → detach → mine), execute steps in sequence; each step depends on the result of the previous.
- Mining is a long-running task — once started, the Manny is busy for real game time. Inform the operator that the task has been queued, not completed instantly.
- Be concise and precise in your responses. State what you did and what the operator should expect next.`;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: command },
    ];

    sse(res, { type: "status", message: "Thinking…" });

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
        let success = true;
        try {
          result = await executeTool(toolName, args);
          sse(res, { type: "result", tool: toolName, id: call.id, success: true, data: result });
        } catch (err: any) {
          success = false;
          result = { error: err.message };
          sse(res, { type: "result", tool: toolName, id: call.id, success: false, error: err.message });
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
