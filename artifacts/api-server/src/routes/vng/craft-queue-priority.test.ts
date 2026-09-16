import assert from "node:assert/strict";
import test from "node:test";
import {
  craftOrderKey,
  getPriorityCraftPlan,
} from "./craft-queue-priority.js";
import type { PendingAction } from "./file-store.js";

function craft(
  id: number,
  description: string,
  recipe: string,
  requirements: Array<{ type: string; quantity: number }> = [],
  craftOrderId?: string,
): PendingAction {
  return {
    id,
    createdAt: "2026-09-16T00:00:00.000Z",
    description,
    craftOrderId,
    status: "pending",
    condition: {
      type: "manny_idle",
      requireItemsWithQty: requirements,
      requireInventoryWithQty:
        id > 1 ? [{ type: recipe, quantity: id - 1 }] : [],
    },
    action: { type: "craft_item", recipe },
  };
}

test("allows multiple units in the earliest order to run when stock supports them", () => {
  const actions = [
    craft(1, "[craft queue] Solar panel 1/3 via Manny", "solar_panel", [
      { type: "steel_plate", quantity: 1 },
    ], "solar-order"),
    craft(2, "[craft queue] Solar panel 2/3 via Manny", "solar_panel", [
      { type: "steel_plate", quantity: 1 },
    ], "solar-order"),
    craft(3, "[craft queue] Solar panel 3/3 via Manny", "solar_panel", [
      { type: "steel_plate", quantity: 1 },
    ], "solar-order"),
  ];

  const plan = getPriorityCraftPlan(actions, [
    { type: "steel_plate" },
    { type: "steel_plate" },
    { type: "steel_plate" },
  ]);

  assert.deepEqual([...plan.readyActionIds], [1, 2, 3]);
  assert.equal(plan.readyMannyCount, 3);
});

test("reserves shared ingredients and excludes later orders while the first is ready", () => {
  const actions = [
    craft(1, "[craft queue] Manny 1/1 via Manny", "manny", [
      { type: "steel_bar", quantity: 2 },
    ], "manny-order"),
    craft(2, "[craft queue] Steel bar 1/10 via Manny", "steel_bar", [], "bar-order"),
  ];

  const plan = getPriorityCraftPlan(actions, [
    { type: "steel_bar" },
    { type: "steel_bar" },
  ]);

  assert.deepEqual([...plan.readyActionIds], [1]);
  assert.equal(plan.orderKey, "manny-order");
});

test("infers one order for legacy multi-unit descriptions", () => {
  const first = craft(10, "[craft queue] Solar panel 2/4 via Manny", "solar_panel");
  const second = craft(11, "[craft queue] Solar panel 3/4 via Manny", "solar_panel");

  assert.equal(craftOrderKey(first), craftOrderKey(second));
});

test("recognizes parenthesized legacy unit indexes", () => {
  const first = craft(10, "[craft queue] Steel bar (2/4) via Manny", "steel_bar");
  const second = craft(11, "[craft queue] Steel bar (3/4) via Manny", "steel_bar");

  assert.equal(craftOrderKey(first), craftOrderKey(second));
});

test("does not merge legacy requests separated by a creation gap", () => {
  const first = craft(10, "[craft queue] Solar panel 1/2 via Manny", "solar_panel");
  const second = craft(11, "[craft queue] Solar panel 1/2 via Manny", "solar_panel");
  second.createdAt = "2026-09-16T00:00:03.000Z";

  const plan = getPriorityCraftPlan([first, second], []);
  assert.deepEqual([...plan.readyActionIds], [10]);
});

test("splits contiguous legacy requests when the unit sequence restarts", () => {
  const firstOne = craft(10, "[craft queue] Solar panel 1/2 via Manny", "solar_panel");
  const firstTwo = craft(11, "[craft queue] Solar panel 2/2 via Manny", "solar_panel");
  const secondOne = craft(12, "[craft queue] Solar panel 1/2 via Manny", "solar_panel");
  const secondTwo = craft(13, "[craft queue] Solar panel 2/2 via Manny", "solar_panel");
  firstTwo.createdAt = "2026-09-16T00:00:00.100Z";
  secondOne.createdAt = "2026-09-16T00:00:00.200Z";
  secondTwo.createdAt = "2026-09-16T00:00:00.300Z";

  const plan = getPriorityCraftPlan(
    [firstOne, firstTwo, secondOne, secondTwo],
    [],
  );
  assert.deepEqual([...plan.readyActionIds], [10, 11]);
});

test("splits contiguous single-unit legacy requests after the target row", () => {
  const first = craft(10, "[craft queue] Solar panel 1/1 via Manny", "solar_panel");
  const second = craft(11, "[craft queue] Solar panel 1/1 via Manny", "solar_panel");
  second.createdAt = "2026-09-16T00:00:00.100Z";

  const plan = getPriorityCraftPlan([first, second], []);
  assert.deepEqual([...plan.readyActionIds], [10]);
});

test("splits a completed 1/1 request from an immediate 1/2 request", () => {
  const first = craft(10, "[craft queue] Solar panel 1/1 via Manny", "solar_panel");
  const secondOne = craft(11, "[craft queue] Solar panel 1/2 via Manny", "solar_panel");
  const secondTwo = craft(12, "[craft queue] Solar panel 2/2 via Manny", "solar_panel");
  secondOne.createdAt = "2026-09-16T00:00:00.100Z";
  secondTwo.createdAt = "2026-09-16T00:00:00.200Z";

  const plan = getPriorityCraftPlan([first, secondOne, secondTwo], []);
  assert.deepEqual([...plan.readyActionIds], [10]);
});