import type { DroneRoleType } from "./drone-roles-store.js";
import type { PendingActionPayload } from "./file-store.js";

type ScheduledActionType = PendingActionPayload["type"];

/**
 * An enabled drone role has exclusive ownership of its probe's scheduled
 * action surface. Each role manages some combination of navigation, Mannies,
 * resources, or containers. Factory is the exception for explicit craft-queue
 * actions: those may share the probe while the factory is idle. The poller
 * defers them during role polls and while any factory role is in an active
 * phase. Keep this table exhaustive so new role/action types require a decision.
 */
type RoleActionPolicy = "blocked" | "craft_queue_only";

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
    craft_item: "craft_queue_only",
    atomic_printer_craft: "craft_queue_only",
    mine_resources: "blocked",
    detach_container: "blocked",
    recover_container: "blocked",
  },
} satisfies Record<
  DroneRoleType,
  Record<ScheduledActionType, RoleActionPolicy>
>;

/** Return the enabled role that makes this scheduled action unsafe, if any. */
export function findScheduledActionRoleConflict(
  actionType: ScheduledActionType,
  enabledRoleTypes: readonly DroneRoleType[],
  options: { isCraftQueueAction?: boolean } = {},
): DroneRoleType | null {
  const isCraftingAction =
    actionType === "craft_item" || actionType === "atomic_printer_craft";
  return (
    enabledRoleTypes.find(
      (roleType) => {
        const policy = ROLE_ACTION_POLICY[roleType][actionType];
        if (policy === "blocked") return true;
        return !(isCraftingAction && options.isCraftQueueAction);
      },
    ) ?? null
  );
}

/**
 * A Factory role shares its probe with queued crafts only between role cycles,
 * and only while every enabled Factory assignment is idle. Missing phase data
 * fails closed.
 */
export function canFactoryRoleShareCraftQueue(
  factoryRolePhases: readonly (string | undefined)[],
  roleAutomationRunning: boolean,
): boolean {
  return (
    factoryRolePhases.length > 0 &&
    !roleAutomationRunning &&
    factoryRolePhases.every((phase) => phase === "idle")
  );
}