import { test } from "node:test";
import assert from "node:assert/strict";

import { findScheduledActionRoleConflict } from "./scheduled-action-role-compatibility.js";
import { VngApiError } from "./client.js";
import {
  getMiningWorkerReserve,
  handlePendingActionError,
} from "./poller.js";
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

test("scheduled action 409 conflicts stay pending for a later poll", async () => {
  const resolutions: Array<{ id: number; patch: unknown }> = [];
  const outcome = await handlePendingActionError(
    31063,
    new VngApiError(409, "The Manny is already executing an order."),
    "test",
    async (id, patch) => { resolutions.push({ id, patch }); },
  );

  assert.equal(outcome, "pause");
  assert.deepEqual(resolutions, []);
});

test("mining reserves one worker for factory-role work without reducing a larger craft reserve", () => {
  assert.equal(getMiningWorkerReserve(0, false), 0);
  assert.equal(getMiningWorkerReserve(0, true), 1);
  assert.equal(getMiningWorkerReserve(3, true), 3);
});