import type { PendingAction } from "./file-store.js";

export function isCraftingAction(action: PendingAction): boolean {
  return (
    action.action.type === "craft_item" ||
    action.action.type === "atomic_printer_craft"
  );
}

function parseLegacyOrderDescription(description: string): {
  target: string;
  unitIndex: number;
  unitCount: number;
  isTargetRow: boolean;
} | null {
  const match = description.match(
    /^\[craft queue\]\s+(.+?)\s+\(?(\d+)\/(\d+)\)?(.*)$/,
  );
  if (!match) return null;
  return {
    target: match[1],
    unitIndex: Number(match[2]),
    unitCount: Number(match[3]),
    isTargetRow: match[4].trimStart().startsWith("via "),
  };
}

export function craftOrderKey(action: PendingAction): string {
  if (action.craftOrderId) return action.craftOrderId;

  // Legacy rows predate explicit order IDs. Their description starts with the
  // requested output followed by its unit index.
  const parsed = parseLegacyOrderDescription(action.description);
  return parsed
    ? `legacy:${action.probeId ?? "main"}:${parsed.target}`
    : `legacy-action:${action.id}`;
}

export function getCraftingReserve(
  totalMannies: number,
  readyMannyCount: number,
): number {
  const miningFirstCap = Math.floor(Math.max(0, totalMannies) * 0.25);
  return Math.min(miningFirstCap, Math.max(0, readyMannyCount));
}

export function getPriorityCraftPlan(
  actions: PendingAction[],
  inventoryItems: Array<{ type?: string; id?: string }>,
): {
  orderKey: string | null;
  readyActionIds: Set<number>;
  readyMannyCount: number;
} {
  const firstCraft = actions.find(isCraftingAction);
  if (!firstCraft) {
    return { orderKey: null, readyActionIds: new Set(), readyMannyCount: 0 };
  }

  const orderKey = craftOrderKey(firstCraft);
  const firstIndex = actions.indexOf(firstCraft);
  const firstIsExplicit = Boolean(firstCraft.craftOrderId);
  const orderActions: PendingAction[] = [];
  let previousCreatedAt = Date.parse(firstCraft.createdAt);
  let highestUnitIndex =
    parseLegacyOrderDescription(firstCraft.description)?.unitIndex ?? 0;
  let orderCompleted = false;

  for (let index = firstIndex; index < actions.length; index++) {
    const action = actions[index];
    if (!isCraftingAction(action)) continue;
    if (firstIsExplicit) {
      if (action.craftOrderId !== firstCraft.craftOrderId) continue;
    } else {
      if (orderCompleted) break;
      if (action.craftOrderId || craftOrderKey(action) !== orderKey) break;
      const parsed = parseLegacyOrderDescription(action.description);
      if (
        orderActions.length > 0 &&
        parsed &&
        parsed.unitIndex < highestUnitIndex
      ) {
        break;
      }
      const createdAt = Date.parse(action.createdAt);
      if (
        orderActions.length > 0 &&
        Number.isFinite(createdAt) &&
        Number.isFinite(previousCreatedAt) &&
        createdAt - previousCreatedAt > 2_000
      ) {
        break;
      }
      previousCreatedAt = createdAt;
      if (parsed) highestUnitIndex = Math.max(highestUnitIndex, parsed.unitIndex);
      if (
        parsed?.isTargetRow &&
        parsed.unitIndex === parsed.unitCount
      ) {
        orderCompleted = true;
      }
    }
    orderActions.push(action);
  }
  const available = new Map<string, number>();
  for (const item of inventoryItems) {
    const type = item.type ?? item.id;
    if (type) available.set(type, (available.get(type) ?? 0) + 1);
  }

  const readyActionIds = new Set<number>();
  let readyMannyCount = 0;

  for (const action of orderActions) {
    const requirements = action.condition.requireItemsWithQty ?? [];
    const ready = requirements.every(
      ({ type, quantity }) => (available.get(type) ?? 0) >= quantity,
    );
    if (!ready) continue;

    readyActionIds.add(action.id);
    if (action.action.type === "craft_item") readyMannyCount++;
    for (const { type, quantity } of requirements) {
      available.set(type, (available.get(type) ?? 0) - quantity);
    }
  }

  return { orderKey, readyActionIds, readyMannyCount };
}