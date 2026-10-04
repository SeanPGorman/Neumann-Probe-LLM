import type { DroneRoleType } from "./drone-roles-store.js";
import type { PendingActionPayload } from "./file-store.js";

type ScheduledActionType = PendingActionPayload["type"];

/**
 * An enabled drone role has exclusive ownership of its probe's scheduled
 * action surface. Each role manages some combination of navigation, Mannies,
 * resources, or containers; allowing an independently queued action to mutate
 * those during a role cycle is not safe. Keep this table exhaustive so newly
 * added role or action types require an explicit compatibility decision.
 */
const ROLE_ACTION_POLICY = {
  refuel: {
    move_probe: "blocked",
    craft_item: "blocked",
    atomic_printer_craft: "blocked",
    mine_resources: "blocked",
    detach_container: "blocked",
    recover_container: "blocked",
  },
  delivery: {
    move_probe: "blocked",
    craft_item: "blocked",
    atomic_printer_craft: "blocked",
    mine_resources: "blocked",
    detach_container: "blocked",
    recover_container: "blocked",
  },
  explorer: {
    move_probe: "blocked",
    craft_item: "blocked",
    atomic_printer_craft: "blocked",
    mine_resources: "blocked",
    detach_container: "blocked",
    recover_container: "blocked",
  },
  ball_explorer: {
    move_probe: "blocked",
    craft_item: "blocked",
    atomic_printer_craft: "blocked",
    mine_resources: "blocked",
    detach_container: "blocked",
    recover_container: "blocked",
  },
  factory: {
    move_probe: "blocked",
    craft_item: "blocked",
    atomic_printer_craft: "blocked",
    mine_resources: "blocked",
    detach_container: "blocked",
    recover_container: "blocked",
  },
} satisfies Record<
  DroneRoleType,
  Record<ScheduledActionType, "blocked">
>;

/** Return the enabled role that makes this scheduled action unsafe, if any. */
export function findScheduledActionRoleConflict(
  actionType: ScheduledActionType,
  enabledRoleTypes: readonly DroneRoleType[],
): DroneRoleType | null {
  return (
    enabledRoleTypes.find(
      (roleType) => ROLE_ACTION_POLICY[roleType][actionType] === "blocked",
    ) ?? null
  );
}