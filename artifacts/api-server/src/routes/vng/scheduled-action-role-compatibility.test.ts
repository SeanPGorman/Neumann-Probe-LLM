import { test } from "node:test";
import assert from "node:assert/strict";

import { findScheduledActionRoleConflict } from "./scheduled-action-role-compatibility.js";
import type { DroneRoleType } from "./drone-roles-store.js";
import type { PendingActionPayload } from "./file-store.js";

const ROLE_TYPES: DroneRoleType[] = [
  "refuel",
  "delivery",
  "explorer",
  "ball_explorer",
  "factory",
];

const ACTION_TYPES: PendingActionPayload["type"][] = [
  "move_probe",
  "craft_item",
  "atomic_printer_craft",
  "mine_resources",
  "detach_container",
  "recover_container",
];

test("scheduled actions are allowed when the target has no enabled role", () => {
  for (const actionType of ACTION_TYPES) {
    assert.equal(findScheduledActionRoleConflict(actionType, []), null);
  }
});

test("every enabled role defers every scheduled action type", () => {
  for (const roleType of ROLE_TYPES) {
    for (const actionType of ACTION_TYPES) {
      assert.equal(
        findScheduledActionRoleConflict(actionType, [roleType]),
        roleType,
        `${roleType} should reserve the probe from ${actionType}`,
      );
    }
  }
});

test("the first enabled role is reported when multiple roles target a probe", () => {
  assert.equal(
    findScheduledActionRoleConflict("move_probe", ["delivery", "factory"]),
    "delivery",
  );
});