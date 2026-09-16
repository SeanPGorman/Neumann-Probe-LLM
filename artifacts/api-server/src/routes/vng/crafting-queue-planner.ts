export type CraftingRecipe = {
  id: string;
  name: string;
  craftableBy?: string[];
  ingredients?: Array<{
    kind: "item" | "resource";
    type: string;
    quantity: number;
  }>;
};

export type PlannedCraftAction = {
  recipeId: string;
  recipeName: string;
  machine: "manny" | "atomic_3d_printer";
  unitIndex: number;
  unitCount: number;
  itemIndex: number;
  itemCount: number;
  depth: number;
  requireItemsWithQty: Array<{ type: string; quantity: number }>;
  requireInventoryWithQty: Array<{ type: string; quantity: number }>;
};

function mergeRequirements(
  requirements: Array<{ type: string; quantity: number }>,
): Array<{ type: string; quantity: number }> {
  const merged = new Map<string, number>();
  for (const requirement of requirements) {
    merged.set(
      requirement.type,
      (merged.get(requirement.type) ?? 0) + requirement.quantity,
    );
  }
  return [...merged].map(([type, quantity]) => ({ type, quantity }));
}

export function planCraftQueue({
  recipes,
  inventoryItems,
  recipeId,
  quantity,
}: {
  recipes: CraftingRecipe[];
  inventoryItems: Record<string, number>;
  recipeId: string;
  quantity: number;
}): PlannedCraftAction[] {
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const target = recipeById.get(recipeId);
  if (!target) throw new Error(`Recipe not found: ${recipeId}`);
  const printerOnlyRecipeIds = new Set(
    recipes
      .filter((recipe) => {
        const machines = recipe.craftableBy ?? [];
        return machines.includes("atomic_3d_printer") && !machines.includes("manny");
      })
      .map((recipe) => recipe.id),
  );

  const virtualInventory = new Map(
    Object.entries(inventoryItems).map(([type, count]) => [type, count]),
  );
  const actions: PlannedCraftAction[] = [];
  const depthMemo = new Map<string, number>();

  function depth(id: string, visiting = new Set<string>()): number {
    const cached = depthMemo.get(id);
    if (cached != null) return cached;
    if (visiting.has(id)) throw new Error(`Cyclic crafting recipe dependency: ${id}`);
    visiting.add(id);
    const recipe = recipeById.get(id);
    const itemDependencies = (recipe?.ingredients ?? []).filter(
      (ingredient) =>
        ingredient.kind === "item" &&
        recipeById.has(ingredient.type) &&
        !printerOnlyRecipeIds.has(ingredient.type),
    );
    const result = itemDependencies.length
      ? Math.max(...itemDependencies.map((ingredient) => depth(ingredient.type, visiting) + 1))
      : 0;
    visiting.delete(id);
    depthMemo.set(id, result);
    return result;
  }

  function scheduleRecipe(id: string, count: number, unitIndex: number): void {
    const recipe = recipeById.get(id);
    if (!recipe) return;

    for (let itemIndex = 1; itemIndex <= count; itemIndex++) {
      const directItemRequirements = mergeRequirements(
        (recipe.ingredients ?? [])
          // Printer-only recipes are queued when directly requested, but are
          // deliberately outside dependency expansion for Manny-built items.
          // The final VNG build order remains authoritative for their presence.
          .filter(
            (ingredient) =>
              ingredient.kind === "item" &&
              !printerOnlyRecipeIds.has(ingredient.type),
          )
          .map((ingredient) => ({
            type: ingredient.type,
            quantity: ingredient.quantity,
          })),
      );

      for (const requirement of directItemRequirements) {
        const available = virtualInventory.get(requirement.type) ?? 0;
        const missing = Math.max(0, requirement.quantity - available);
        if (missing > 0 && recipeById.has(requirement.type)) {
          scheduleRecipe(requirement.type, missing, unitIndex);
          virtualInventory.set(
            requirement.type,
            (virtualInventory.get(requirement.type) ?? 0) + missing,
          );
        }
        virtualInventory.set(
          requirement.type,
          Math.max(0, (virtualInventory.get(requirement.type) ?? 0) - requirement.quantity),
        );
      }

      const craftableBy = recipe.craftableBy ?? [];
      const machine =
        craftableBy.includes("atomic_3d_printer") && !craftableBy.includes("manny")
          ? "atomic_3d_printer"
          : "manny";

      actions.push({
        recipeId: id,
        recipeName: recipe.name,
        machine,
        unitIndex,
        unitCount: quantity,
        itemIndex,
        itemCount: count,
        depth: depth(id),
        requireItemsWithQty: directItemRequirements,
        requireInventoryWithQty: [],
      });
    }
  }

  for (let unitIndex = 1; unitIndex <= quantity; unitIndex++) {
    scheduleRecipe(recipeId, 1, unitIndex);
    virtualInventory.set(recipeId, (virtualInventory.get(recipeId) ?? 0) + 1);
  }

  return actions;
}