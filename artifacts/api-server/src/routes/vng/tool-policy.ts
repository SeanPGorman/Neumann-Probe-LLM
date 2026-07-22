/**
 * Tool safety classification + the opt-in brain fence.
 *
 * Two concerns live here:
 *
 *  1. A reversibility classification of every game tool (SAFE vs IRREVERSIBLE).
 *  2. An OPT-IN fence, `VNG_SAFE_ONLY`, that — when enabled — limits BOTH brains
 *     (OpenAI and Claude) to the SAFE tools. Default OFF: both brains get the
 *     full tool set, exactly as before, so nothing changes unless an operator
 *     opts in.
 *
 * WHY A SEPARATE FILE, KEYED BY NAME:
 * `tools.ts` is generated wholesale and can be regenerated in one commit. Safety
 * metadata colocated with each tool definition would be silently erased by such
 * a regeneration — and because an unclassified tool is treated as non-SAFE, that
 * erasure would quietly strip the brain's reach while looking like a routine
 * change. Keeping the classification here, keyed by tool NAME (the only stable
 * handle across a regeneration), plus `assertPolicyCoversTools()`, turns any
 * drift into a loud boot failure instead of a silent hole.
 */
import { TOOLS } from "./tools.js";

/** Reversible or read-only — safe for an unattended brain to call. */
export const SAFE = new Set<string>([
  "get_game_state",
  "scan_sector",
  "craft_item",
  "atomic_printer_craft",
  "mine_resources",
  "inspect_sector_object",
  "repair_manny",
  "rename_manny",
  "deploy_manny",
  "recover_container",
  "refill_deuterium_tank",
  "schedule_action",
  "cancel_scheduled_action",
]);

/**
 * Permanently changes game state with no documented undo. Reachable by a brain
 * only when the `VNG_SAFE_ONLY` fence is OFF (the default).
 */
export const IRREVERSIBLE = new Set<string>([
  "move_probe",
  "jettison_item",
  "detach_container",
  "drop_container_on_asteroid",
  "drop_container_on_planet",
  "salvage_object",
  "recall_manny",
  "drop_manny_cargo",
  "assemble_probe", // consumes parts; no documented refund or un-assemble
  "send_message", // reaches other players' probes/planets; no unsend
  "transfer_deuterium", // can hand fuel to another probe; no take-back
  "improve_probe", // installs an upgrade; the only cancel path is recall_manny
  "turn_on_relay", // becomes permanent SCUT infrastructure; no turn-off endpoint
  "install_waypoint_bookmark", // permanent, un-deletable public beacon
]);

/**
 * The fence toggle. OFF by default; any truthy value except the usual "off"
 * spellings turns it ON. A strict `=== "1"` check was avoided on purpose: for a
 * SAFETY fence, silently doing nothing on `VNG_SAFE_ONLY=true` is the wrong
 * failure direction.
 */
function envEnabled(v: string | undefined): boolean {
  if (!v) return false;
  return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

export const SAFE_ONLY = envEnabled(process.env.VNG_SAFE_ONLY);

/** May a brain call this tool under the current fence setting? */
export function isToolAllowed(name: string): boolean {
  return SAFE_ONLY ? SAFE.has(name) : true;
}

/**
 * Filter a tool list to the set both brains may advertise/expose under the
 * current fence. When the fence is off this returns the input array unchanged
 * (identity), so the default path is provably the same as before.
 */
export function allowedTools<T extends { function: { name: string } }>(
  tools: T[],
): T[] {
  return SAFE_ONLY ? tools.filter((t) => SAFE.has(t.function.name)) : tools;
}

/**
 * Fail fast if the classification and the tool list have drifted apart. An
 * upstream change that adds or renames a tool stops the server here — naming the
 * offending tools — instead of silently changing what a fenced brain can reach.
 */
export function assertPolicyCoversTools(): void {
  const defined = new Set(TOOLS.map((t) => t.function.name));
  const classified = [...SAFE, ...IRREVERSIBLE];

  const unclassified = [...defined].filter((n) => !classified.includes(n));
  const orphaned = classified.filter((n) => !defined.has(n));
  // The sets must be disjoint: the fence keys on SAFE.has(name), so a tool in
  // BOTH sets would be exposed to a fenced brain while coverage stays green —
  // the one miscategorization that fails toward the dangerous direction.
  const counts = new Map<string, number>();
  for (const n of classified) counts.set(n, (counts.get(n) ?? 0) + 1);
  const overlapping = [...counts].filter(([, c]) => c > 1).map(([n]) => n);

  const problems: string[] = [];
  if (unclassified.length)
    problems.push(`tools with no policy entry: ${unclassified.join(", ")}`);
  if (orphaned.length)
    problems.push(`policy entries with no such tool: ${orphaned.join(", ")}`);
  if (overlapping.length)
    problems.push(
      `tools classified in more than one set: ${overlapping.join(", ")}`,
    );
  if (problems.length)
    throw new Error(
      `tool-policy is out of sync with tools.ts — ${problems.join("; ")}`,
    );
}
