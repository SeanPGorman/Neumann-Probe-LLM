import { Router } from "express";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp, constants as fsc, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as client from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import {
  cancelPendingAction,
  recordSector,
  getFloatingContainers,
  getPendingActions,
  DATA_DIR,
} from "./file-store.js";
import { afterTool } from "./after-tool.js";
import {
  allowedTools,
  isToolAllowed,
  assertPolicyCoversTools,
  SAFE_ONLY,
} from "./tool-policy.js";
import { mapSectorObjects } from "./sector-map.js";

// Fail fast if the tool classification drifted from the tool list.
assertPolicyCoversTools();

const router = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// ── Claude brain (optional second provider) ───────────────────────────────────
// Resolve paths relative to this bundled module (dist/index.mjs).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(HERE, "neumann-mcp.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CLAUDE_MODEL = process.env.CLAUDE_BRAIN_MODEL || "sonnet";

// The Claude brain is handed the same tools the OpenAI brain advertises —
// MCP-prefixed. This tracks the fence: when VNG_SAFE_ONLY is off (default) it is
// the full set; when on, only the SAFE tools, matching what the MCP server will
// actually expose.
const ALLOWED_MCP_TOOLS = allowedTools(TOOLS)
  .map((t) => `mcp__neumann__${t.function.name}`)
  .join(" ");

/**
 * Resolve the `claude` executable to spawn — ALWAYS as a real executable run
 * without a shell. We never fall back to `shell: true`, because that would build
 * a cmd.exe command line containing the (request-controlled) prompt, where shell
 * metacharacters would execute. Instead we locate a real .exe and let argv pass
 * straight to CreateProcess/execvp, where the prompt is inert data.
 *
 * A `.cmd`/`.bat`/`.ps1` shim (the usual npm-global layout on Windows) cannot be
 * spawned without a shell, so if that's all we can find we fail with a clear
 * message telling the operator to point CLAUDE_BIN at the real executable.
 */
function assertRealExecutable(p: string): void {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    throw new Error(
      `CLAUDE_BIN points at a shell shim (${p}). Set CLAUDE_BIN to the real ` +
        `claude executable (e.g. the .exe); the brain spawns it without a shell.`,
    );
  }
}

function findClaudeOnWindowsPath(): string {
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  let shimOnly: string | null = null;
  for (const dir of dirs) {
    for (const ext of [".exe", ".com"]) {
      const cand = path.join(dir, `claude${ext}`);
      if (existsSync(cand)) return cand;
    }
    if (!shimOnly) {
      for (const ext of [".cmd", ".bat", ".ps1"]) {
        const cand = path.join(dir, `claude${ext}`);
        if (existsSync(cand)) {
          shimOnly = cand;
          break;
        }
      }
    }
  }
  if (shimOnly)
    throw new Error(
      `Found only a shell shim for the claude CLI (${shimOnly}). Set CLAUDE_BIN ` +
        `to the real claude executable (.exe); the brain spawns it without a shell.`,
    );
  throw new Error(
    `Could not find the 'claude' CLI on PATH. Install it, or set CLAUDE_BIN to ` +
      `its full path (a real executable, not a .cmd/.bat shim).`,
  );
}

function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) {
    assertRealExecutable(process.env.CLAUDE_BIN);
    return process.env.CLAUDE_BIN;
  }
  const guess = path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  if (existsSync(guess)) return guess;
  // On Windows a bare name won't resolve a real .exe reliably (and never a .cmd
  // without a shell), so search PATH explicitly and give a clear error.
  if (process.platform === "win32") return findClaudeOnWindowsPath();
  // On POSIX, spawn without a shell resolves an executable on PATH itself.
  return "claude";
}

// The Claude brain doesn't get a pre-built state dump (unlike the OpenAI loop);
// it loads state itself by calling get_game_state first.
function buildPrompt(command: string, probeId: number | null): string {
  const rules = `You are GUPPI, the onboard AI operator of a Von Neumann Probe. Carry out the operator's orders by calling the provided game tools (exposed via the "neumann" MCP server).

OPERATING RULES:
- ALWAYS call get_game_state FIRST to load the current probe status, mannies (with their exact string IDs), sector objects, inventory, and crafting recipes. Never invent IDs — only use IDs returned by the tools.
- Use exact Manny IDs (long strings like "mny_e84fa37181de693e8e831147").
- Mining, crafting, and salvage are long-running: once started the Manny is busy for real game time. Tell the operator the task was QUEUED.
- For "when X finishes, do Y" style orders, use schedule_action and report the scheduled action ID.
- MINING A SOLAR SYSTEM: when the sector shows a solar_system object and you need to mine, you MUST call scan_sector for the current sector (x, y, z) first. The scan returns a bookmarkTargets array inside the solar_system object — those are the individual body IDs you can mine. The solar_system wrapper itself cannot be mined. Pick by category: "frozen"/"ocean" for ice and organics, "rocky"/"dwarf" for metals, any for deuterium. Then mine the chosen body ID. Do this automatically without asking.
- Be concise and precise. End with a short summary of what you did or found.`;

  const targetProbe =
    probeId != null
      ? `TARGET PROBE:
Your tools are scoped to probe #${probeId} — the one the operator selected. Every tool call already addresses it; do not pass a probe ID yourself, and report results as being about probe #${probeId}.`
      : null;

  return [rules, targetProbe, `OPERATOR ORDER:\n${command}`]
    .filter(Boolean)
    .join("\n\n");
}

// Strip the MCP prefix so tool events render with their bare game-tool name.
function stripPrefix(toolName: string): string {
  return toolName.replace(/^mcp__neumann__/, "");
}

function sse(res: import("express").Response, event: Record<string, unknown>) {
  // Guard centrally so no caller (the buffered readline handler, a late
  // child 'error', a timeout) can write after the response has ended — that
  // throws ERR_STREAM_WRITE_AFTER_END, which would be unhandled.
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Shared state extraction ───────────────────────────────────────────────────
function extractCoreState(probeResp: any, manniesResp: any, sectorResp: any) {
  const probe = probeResp.probe;
  const inv = probe.inventory ?? {};
  const sector: { x: number; y: number; z: number } =
    probe.sector?.relative ??
    sectorResp?.sector?.relativeCoordinates ??
    { x: 0, y: 0, z: 0 };
  const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];
  const mannies: any[] = manniesResp.mannies ?? [];
  const inventoryItems: any[] = inv.items ?? [];
  const activeMannyIds = new Set(mannies.map((m: any) => m.id));
  const stowedMannies = inventoryItems.filter(
    (i: any) => i.type === "manny" && !activeMannyIds.has(i.id)
  );
  return { probe, inv, sector, sectorObjects, mannies, inventoryItems, activeMannyIds, stowedMannies };
}

// ── Routes ────────────────────────────────────────────────────────────────────

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

router.get("/probes", async (_req, res) => {
  try {
    const data = await client.getProbeList();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/state", async (req, res) => {
  let probeId: number | null;
  try {
    probeId = client.parseProbeId(req.query.probeId);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  try {
    const [probeResp, manniesResp, sectorResp] = await Promise.all([
      probeId ? client.getProbeById(probeId) : client.getProbe(),
      probeId ? client.getManniesById(probeId) : client.getMannies(),
      (probeId ? client.getSectorById(probeId) : client.getSector()).catch(() => null),
    ]);

    const { probe, inv, sector, sectorObjects, mannies, activeMannyIds, stowedMannies } =
      extractCoreState(probeResp, manniesResp, sectorResp);

    // getSector() yields null ONLY when it threw — transit or a real fetch
    // error — which is distinct from a successful-but-empty sector. Surface it
    // so the UI can show "data unavailable" instead of falsely claiming the
    // sector is empty.
    const sectorUnavailable = sectorResp === null;

    // Only persist a scan that actually succeeded. On a failed fetch
    // sectorObjects is [] — recording that would clobber the last-known-good
    // detail for this sector (visited-sectors store, read by the MAP/SECTORS
    // tabs) with an empty list.
    if (!sectorUnavailable)
      recordSector(sector.x, sector.y, sector.z, sectorObjects).catch((e) => console.error("[recordSector /state]", e));

    const manniesNorm = mannies.map((m: any) => {
      const task = m.task && typeof m.task === "object" && !Array.isArray(m.task) ? m.task : null;
      return {
        id: m.id,
        name: m.name,
        currentTask: m.currentTask,
        taskProgressPercent: m.taskProgressPercent,
        taskEstimatedEndTime: m.taskEstimatedEndTime ?? null,
        location: m.location ?? null,
        taskVisibility: m.taskVisibility ?? null,
        taskObjectId: task?.objectId ?? null,
        taskPhase: task?.phase ?? null,
        taskTripIndex: task?.tripIndex ?? null,
        miningTravelSeconds: task?.miningTravelSeconds ?? null,
        taskTargetAmount: task?.targetAmount ?? null,
        taskDepositedAmount: task?.depositedAmount ?? null,
      };
    });

    const stowedNorm = ((probeResp.probe?.inventory?.items ?? []) as any[])
      .filter((i: any) => i.type === "manny" && !activeMannyIds.has(i.id))
      .map((i: any) => ({ itemId: i.id, name: i.label ?? i.name ?? "Unnamed Manny" }));

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
      mannies: manniesNorm,
      stowedMannies: stowedNorm,
      sectorObjects: mapSectorObjects(sectorObjects),
      otherProbes: sectorResp?.sector?.probes ?? [],
      sectorUnavailable,
      scan: sectorResp?.sector?.scan ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/command", async (req, res) => {
  const {
    command,
    probeId: rawProbeId,
    sessionId: bodySessionId,
    provider: bodyProvider,
  } = req.body as {
    command: string;
    probeId?: number | null;
    sessionId?: string;
    provider?: string;
  };

  if (!command?.trim()) {
    res.status(400).json({ error: "command is required" });
    return;
  }

  let probeId: number | null;
  try {
    probeId = client.parseProbeId(rawProbeId);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  // Which brain runs the order. Default "openai" (the loop below, unchanged);
  // set VNG_BRAIN=claude (or send { provider: "claude" }) to use the local
  // Claude CLI. A per-request provider wins over the env default. Validated
  // here — before the SSE headers flush — so an unknown value is a clean 400
  // rather than a silent fallback to OpenAI (which would bill per-token while
  // the operator believes they picked another brain).
  const provider = String(
    bodyProvider || process.env.VNG_BRAIN || "openai",
  ).toLowerCase();
  if (provider !== "openai" && provider !== "claude") {
    res.status(400).json({ error: `Unknown brain provider: ${provider}` });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (provider === "claude") {
    const sessionId = bodySessionId?.trim() || randomUUID();
    await runClaudeBrain(req, res, { command, sessionId, probeId });
    return;
  }

  await runOpenAiBrain(res, { command, probeId });
});

async function runOpenAiBrain(
  res: import("express").Response,
  { command, probeId }: { command: string; probeId: number | null },
): Promise<void> {
  try {
    sse(res, { type: "status", message: "Fetching current probe state…" });

    const c = client.clientFor(probeId);
    const [probeResp, manniesResp, sectorResp, recipesResp] = await Promise.all([
      c.getProbe(),
      c.getMannies(),
      c.getSector().catch(() => null),
      client.getCraftingRecipes(),
    ]);

    const { probe, inv, sector, sectorObjects, mannies, inventoryItems, stowedMannies } =
      extractCoreState(probeResp, manniesResp, sectorResp);

    // Only persist a scan that actually succeeded (see /state) — a failed
    // getSector() yields null → sectorObjects [], and recording that would
    // clobber the sector's last-known-good detail with an empty list.
    if (sectorResp !== null)
      recordSector(sector.x, sector.y, sector.z, sectorObjects).catch((e) => console.error("[recordSector /command]", e));

    const recipes: any[] = recipesResp.recipes ?? [];
    const resourceStocks: any[] = inv.resourceStocks ?? [];

    const idleMannies = mannies.filter((m: any) => !m.currentTask);
    const busyMannies = mannies.filter((m: any) => m.currentTask);

    const boardedContainers = inv.containers ?? [];

    const nonMannyItems = inventoryItems.filter(
      (i: any) => i.type !== "manny" && i.type !== "atomic_3d_printer"
    );

    const trackedFloating = await getFloatingContainers(sector.x, sector.y, sector.z);

    const sectorDetached = sectorObjects.filter((o: any) => o.type === "detached_container");
    const sectorDetachedById = new Map(sectorDetached.map((o: any) => [o.id, o]));

    const floatingContainerLines = trackedFloating.map((c) => {
      const sectorObj = sectorDetachedById.get(c.sectorObjectId);
      const anchor = sectorObj?.targetObjectId ?? c.anchorObjectId;
      const anchorName = c.anchorObjectName ?? (anchor ? `object id="${anchor}"` : "unknown");
      return `  • "${c.containerName}"
      SECTOR OBJECT ID (use for target_container_id or object_id): "${c.sectorObjectId}"
      Anchor: ${anchorName}${anchor ? `  anchor_id="${anchor}"` : ""}
      Detached by: ${c.mannyName} on ${new Date(c.detachedAt).toISOString()}`;
    });

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
  .map((o: any) => {
    const extras: string[] = [];
    if (o.resourceTypes?.length) extras.push(`resources=[${o.resourceTypes.join(",")}]`);
    if (o.type === "deuterium_refuel_station") extras.push("⛽ USE: refill_deuterium_tank");
    if (o.type === "scut_relay" && o.active === false) extras.push("📡 INACTIVE SCUT RELAY — can be activated with a Manny + integrated_circuit");
    if (o.type === "scut_relay" && o.active === true) extras.push("📡 ACTIVE SCUT RELAY");
    if (o.type === "probe") extras.push("🛸 OTHER PROBE — can receive deuterium transfer");
    return `  • [${o.type}] "${o.name ?? "unnamed"}"  id="${o.id ?? "none"}"  ${extras.join("  ")}  ${o.summary ?? ""}`;
  })
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
${recipes.slice(0, 25).map((r: any) => {
  const ing = (r.ingredients ?? []).map((i: any) =>
    i.kind === "resource" ? `${i.quantity}${i.unit === "earth_container_equivalent" ? "ECE" : ""} ${i.type}` : `${i.quantity}× ${i.type}`
  ).join(", ");
  return `  • ${r.id} — "${r.name}"  craftableBy=[${(r.craftableBy ?? []).join(",")}]  duration=${r.durationSeconds}s  needs=[${ing || "nothing"}]`;
}).join("\n")}

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
- PARALLEL BUILDS: When asked to build a complex item, FIRST compute the COMPLETE work breakdown — every ingredient at every level of the recipe tree. Then distribute ALL of that work across ALL available mannies. Do not stop after assigning one task per manny; each manny should have a full sequential chain of crafting tasks (using schedule_action with manny_idle conditions to chain them). Under-utilising mannies is a mistake.
  Example for building a Manny with 8 workers: compute that you need e.g. 18× electric_motor, 6× linear_actuator, 4× battery_pack, 18× steel_plate, 12× steel_bar (plus sub-ingredients). Divide those totals across all 8 mannies; each manny gets a chain like: steel_bar → steel_bar → electric_motor → linear_actuator → schedule next when idle.
- DEPENDENCY GUARD: Use requireItems in the schedule_action condition whenever a step depends on an item being produced by a *different* manny in parallel. Without it, the step could fire before its dependency is ready.
- DETACH CONTAINER: detach_container requires a mode field: "drifting" (free float in sector) or "hidden_on_asteroid" (hidden; also requires asteroid_object_id).
- INSPECT: Use inspect_sector_object for asteroids, drifting containers, AND dormant constructs. Dormant constructs unlock a new probe improvement when inspected. (inspect_asteroid is a deprecated alias and still works.)
- MINING SOLAR SYSTEM: When the sector shows a solar_system object and you need to mine resources, you MUST first call scan_sector with the current sector coordinates (x, y, z). The scan result includes a bookmarkTargets array inside the solar_system object — these are the individual body IDs you can mine from. The solar_system wrapper itself cannot be mined. Choose the appropriate body by category: "frozen" or "ocean" planets for ice/organics; "rocky" or "dwarf" for metals; any for deuterium. After scanning, mine from the chosen body ID. Do this automatically without asking.
- SCUT RELAY ACTIVATION: turn_on_relay requires relay_id (integer — SCUT relay sector object IDs are purely numeric strings, e.g. id="42" → relay_id=42), one integrated_circuit in inventory, and a star in the current sector. Duration ~5 min.
- DEUTERIUM REFUEL: refill_deuterium_tank requires sector to contain a [deuterium_refuel_station] object. Duration ~1 min.
- DEUTERIUM TRANSFER: transfer_deuterium requires another probe as a [probe] sector object. target_probe_id is an integer (e.g. 652). amount is deuterium percentage points to transfer (must be < current reserve).
- PROBE ASSEMBLY: assemble_probe needs 2 distinct empty container inventory IDs (container_ids array). The assembled probe can be controlled via SCUT or the operator can transfer into it (current probe becomes a drone).
- PROBE IMPROVEMENT: improve_probe installs an upgrade. Use get_game_state to see available improvements (probe_improvements list includes ingredients and effects).
- WAYPOINT BOOKMARK: install_waypoint_bookmark places a named beacon on a sector object. Requires waypoint_bookmark item in inventory.
- DROP ON PLANET: drop_container_on_planet drops a container through atmosphere. Requires atmospheric_drop_kit in inventory. planet_id is the sector object ID of the planet.
- DROP MANNY CARGO: drop_manny_cargo discards cargo of a Manny stuck waiting outside for space, then retries docking. Resource cargo is lost; recoverable items returned to sector.
- MESSAGES: send_message sends text to another probe (same sector or shared SCUT network) or an inhabited planet (same sector). recipient_type="probe"|"planet", recipient_id is the numeric probe ID or planet object ID.
- CRAFTING: Mannies can now also craft scut_relay, solar_panel, thermal_protection_shell, parachute_pack, descent_guidance_module, atmospheric_drop_kit. Atomic printer can now craft atomic_printer_part.
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
        tools: allowedTools(TOOLS),
        tool_choice: "auto",
      });

      const msg = completion.choices[0].message;
      messages.push(msg);

      if (msg.content) {
        sse(res, { type: "message", content: msg.content });
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) break;

      for (const call of msg.tool_calls) {
        const toolName = call.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments); } catch { args = {}; }

        sse(res, { type: "action", tool: toolName, params: args, id: call.id });

        let result: unknown;
        let success = false;
        if (!isToolAllowed(toolName)) {
          // Defense in depth: the fenced set isn't advertised, but refuse here
          // too so a model that names a filtered tool anyway can't reach it.
          const error = `Tool not permitted: ${toolName} (VNG_SAFE_ONLY is enabled).`;
          result = { error };
          sse(res, { type: "result", tool: toolName, id: call.id, success: false, error });
        } else {
          try {
            result = await executeTool(toolName, args, probeId);
            success = true;
            sse(res, { type: "result", tool: toolName, id: call.id, success: true, data: result });
          } catch (err: any) {
            result = { error: err.message };
            sse(res, { type: "result", tool: toolName, id: call.id, success: false, error: err.message });
          }
        }

        if (success) {
          // Shared with the Claude brain (see after-tool.ts) so both providers
          // keep the local UI stores in sync.
          await afterTool(toolName, args, result, probeId);
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    sse(res, { type: "done" });
  } catch (err: any) {
    sse(res, { type: "error", message: err.message });
    sse(res, { type: "done" });
  } finally {
    res.end();
  }
}

/**
 * Claude brain: spawns the headless `claude` CLI, wired to a stdio MCP server
 * that exposes the game tools, and translates its stream-json output onto the
 * same SSE event shape the OpenAI brain emits. Requires the `claude` CLI to be
 * installed on the host; only runs when the operator selects it.
 */
async function runClaudeBrain(
  req: import("express").Request,
  res: import("express").Response,
  {
    command,
    sessionId,
    probeId,
  }: { command: string; sessionId: string; probeId: number | null },
): Promise<void> {
  let mcpConfigPath: string | null = null;
  // Map tool_use id -> display tool name so we can label tool_result events.
  const toolNamesById = new Map<string, string>();
  let finished = false;

  const finish = (child?: import("node:child_process").ChildProcess) => {
    if (finished) return;
    finished = true;
    sse(res, { type: "done" });
    res.end();
    if (mcpConfigPath) fsp.unlink(mcpConfigPath).catch(() => {});
    if (child && !child.killed) child.kill();
  };

  try {
    sse(res, { type: "status", message: "Spawning Claude brain…" });

    // Write the MCP config to a temp file (inline JSON breaks Windows quoting).
    const apiKey = process.env.VNG_API_KEY ?? "";
    mcpConfigPath = path.join(os.tmpdir(), `neumann-mcp-${randomUUID()}.json`);
    const mcpConfig = {
      mcpServers: {
        neumann: {
          command: process.execPath,
          args: [MCP_SERVER_PATH],
          env: {
            VNG_API_KEY: apiKey,
            // Same data dir as the api-server so post-tool bookkeeping (afterTool)
            // writes where the UI reads.
            DATA_DIR,
            // Carry the fence to the subprocess explicitly (normalized), so the
            // MCP server exposes the same set the api-server computed rather than
            // depending on env inheritance.
            VNG_SAFE_ONLY: SAFE_ONLY ? "1" : "0",
            // Omitted rather than set to "null" for the main probe, so the MCP
            // server can distinguish unset from a value.
            ...(probeId != null ? { VNG_PROBE_ID: String(probeId) } : {}),
          },
        },
      },
    };
    // Atomic owner-only creation: the config embeds VNG_API_KEY in plaintext, so
    // never leave a world-readable window. O_EXCL guarantees we create a fresh
    // file; 0o600 restricts to owner (no-op on Windows, correct on POSIX).
    {
      const fh = await fsp.open(
        mcpConfigPath,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL,
        0o600,
      );
      try {
        await fh.writeFile(JSON.stringify(mcpConfig), "utf8");
      } finally {
        await fh.close();
      }
    }

    const childEnv = { ...process.env };
    // Auth: by default the CLI uses whatever it's configured with — an
    // ANTHROPIC_API_KEY in the environment, or an OAuth login. Set
    // VNG_CLAUDE_SUBSCRIPTION to force the subscription (OAuth) login by
    // dropping the API key so per-token billing can't take over.
    if (process.env.VNG_CLAUDE_SUBSCRIPTION) {
      delete childEnv.ANTHROPIC_API_KEY;
    }

    const prompt = buildPrompt(command, probeId);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      ALLOWED_MCP_TOOLS,
      "--permission-mode",
      "dontAsk",
      "--session-id",
      sessionId,
      "--model",
      CLAUDE_MODEL,
      prompt,
    ];

    // Always spawned without a shell (shell:false is the default) — see
    // resolveClaudeBin. The request-controlled prompt travels in argv, where
    // without a shell it is inert data, not an injection vector.
    const bin = resolveClaudeBin();
    const child = spawn(bin, args, {
      env: childEnv,
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Safety valve: don't stream forever.
    const timeout = setTimeout(() => {
      sse(res, { type: "error", message: "Brain timed out after 180s." });
      finish(child);
    }, 180_000);

    sse(res, { type: "status", message: "Brain thinking…" });

    const rl = readline.createInterface({ input: child.stdout! });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON noise
      }

      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            sse(res, { type: "message", content: block.text });
          } else if (block.type === "tool_use") {
            const display = stripPrefix(block.name);
            toolNamesById.set(block.id, display);
            sse(res, {
              type: "action",
              tool: display,
              params: block.input ?? {},
              id: block.id,
            });
          }
        }
      } else if (evt.type === "user" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "tool_result") {
            const id = block.tool_use_id;
            const toolName = toolNamesById.get(id) ?? "tool";
            let data: unknown = block.content;
            // MCP tool results arrive as [{type:"text", text:"<json>"}].
            if (Array.isArray(block.content)) {
              const textPart = block.content.find(
                (c: any) => c.type === "text",
              );
              if (textPart?.text) {
                try {
                  data = JSON.parse(textPart.text);
                } catch {
                  data = textPart.text;
                }
              }
            }
            if (block.is_error) {
              sse(res, {
                type: "result",
                tool: toolName,
                id,
                success: false,
                error: typeof data === "string" ? data : JSON.stringify(data),
              });
            } else {
              sse(res, {
                type: "result",
                tool: toolName,
                id,
                success: true,
                data,
              });
            }
          }
        }
      } else if (evt.type === "result") {
        // Final result envelope. If it carries an error, surface it.
        if (evt.is_error && evt.result) {
          sse(res, { type: "error", message: String(evt.result) });
        }
      }
    });

    // Only the first 500 chars are ever surfaced (see the close handler); cap
    // the buffer so a chatty child can't grow it unbounded over the 180s window.
    let stderrBuf = "";
    child.stderr!.on("data", (chunk) => {
      if (stderrBuf.length < 8192) stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      sse(res, {
        type: "error",
        message: `Failed to spawn brain: ${err.message}`,
      });
      finish(child);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !finished) {
        sse(res, {
          type: "error",
          message: `Brain exited with code ${code}. ${stderrBuf.slice(0, 500)}`,
        });
      }
      finish(child);
    });

    // Clean up if the client disconnects.
    req.on("close", () => {
      clearTimeout(timeout);
      finish(child);
    });
  } catch (err: any) {
    sse(res, { type: "error", message: err.message });
    finish();
  }
}

export default router;
