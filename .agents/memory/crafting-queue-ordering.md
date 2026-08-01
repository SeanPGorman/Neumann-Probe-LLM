---
name: Crafting queue ordering — requireItemsWithQty
description: The crafting queue's manny_idle condition must check ingredient quantities, not just type presence, to prevent complex items firing before prerequisites are complete.
---

## Rule
When scheduling a crafting task that depends on sub-items, use `requireItemsWithQty: Array<{type, quantity}>` on the `manny_idle` condition — not the legacy `requireItems: string[]`.

**Why:** The old `requireItems` check in the poller only tested `itemTypes.has(req)` (type present) not quantity. A Manny needing 12 electric_motors would fire after just 1 was crafted. The new check does `itemCountByType.get(type) >= quantity`.

**How to apply:**
- `file-store.ts` `ConditionMannyIdle` has both fields; `requireItems` is deprecated.
- `log.ts` crafting-queue endpoint builds `requireItemsWithQty` from per-unit recipe ingredient quantities.
- `poller.ts` checks `requireItemsWithQty` first (quantity-aware), then falls back to legacy `requireItems` for existing queued actions.
- Quantities in the condition are **per-unit** (one copy of the item), not total. Each task instance independently blocks until that quantity is present.
