import assert from "node:assert/strict";
import test from "node:test";
import { planCraftQueue, type CraftingRecipe } from "./crafting-queue-planner.js";

const recipes: CraftingRecipe[] = [
  {
    id: "steel_bar",
    name: "Steel bar",
    craftableBy: ["manny"],
    ingredients: [{ kind: "resource", type: "metals", quantity: 0.05 }],
  },
  {
    id: "motor",
    name: "Motor",
    craftableBy: ["manny"],
    ingredients: [{ kind: "item", type: "steel_bar", quantity: 2 }],
  },
  {
    id: "manny",
    name: "Manny",
    craftableBy: ["manny"],
    ingredients: [
      { kind: "item", type: "steel_bar", quantity: 1 },
      { kind: "item", type: "motor", quantity: 1 },
    ],
  },
];

test("plans each requested unit as a complete dependency chain", () => {
  const plan = planCraftQueue({
    recipes,
    inventoryItems: {},
    recipeId: "manny",
    quantity: 2,
  });

  assert.deepEqual(
    plan.map((action) => [action.unitIndex, action.recipeId]),
    [
      [1, "steel_bar"],
      [1, "steel_bar"],
      [1, "steel_bar"],
      [1, "motor"],
      [1, "manny"],
      [2, "steel_bar"],
      [2, "steel_bar"],
      [2, "steel_bar"],
      [2, "motor"],
      [2, "manny"],
    ],
  );

  assert.ok(plan.filter((action) => action.unitIndex === 1).every(
    (action) => action.requireInventoryWithQty.length === 0,
  ));
  assert.ok(plan.filter((action) => action.unitIndex === 2).every(
    (action) =>
      action.requireInventoryWithQty.length === 1 &&
      action.requireInventoryWithQty[0].type === "manny" &&
      action.requireInventoryWithQty[0].quantity === 1,
  ));
});

test("uses stocked components for the earliest unit before crafting missing parts", () => {
  const plan = planCraftQueue({
    recipes,
    inventoryItems: { steel_bar: 3 },
    recipeId: "manny",
    quantity: 2,
  });

  assert.deepEqual(
    plan.map((action) => [action.unitIndex, action.recipeId]),
    [
      [1, "motor"],
      [1, "manny"],
      [2, "steel_bar"],
      [2, "steel_bar"],
      [2, "steel_bar"],
      [2, "motor"],
      [2, "manny"],
    ],
  );
});

test("ignores printer-only dependencies when planning a Manny-built item", () => {
  const printerRecipes: CraftingRecipe[] = [
    {
      id: "circuit",
      name: "Circuit",
      craftableBy: ["atomic_3d_printer"],
      ingredients: [],
    },
    {
      id: "relay",
      name: "Relay",
      craftableBy: ["manny"],
      ingredients: [{ kind: "item", type: "circuit", quantity: 1 }],
    },
  ];

  const plan = planCraftQueue({
    recipes: printerRecipes,
    inventoryItems: {},
    recipeId: "relay",
    quantity: 1,
  });

  assert.deepEqual(plan.map((action) => [action.recipeId, action.machine]), [
    ["relay", "manny"],
  ]);
  assert.deepEqual(plan[0].requireItemsWithQty, []);
});

test("still queues a printer-only item when it is directly requested", () => {
  const plan = planCraftQueue({
    recipes: [
      {
        id: "integrated_circuit",
        name: "Integrated circuit",
        craftableBy: ["atomic_3d_printer"],
        ingredients: [],
      },
    ],
    inventoryItems: {},
    recipeId: "integrated_circuit",
    quantity: 1,
  });

  assert.deepEqual(plan.map((action) => [action.recipeId, action.machine]), [
    ["integrated_circuit", "atomic_3d_printer"],
  ]);
});