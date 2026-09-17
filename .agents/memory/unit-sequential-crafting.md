---
name: Mining-first crafting reserve
description: Preferred workforce allocation and order priority rules for mining and multi-quantity crafting.
---

Mining raw materials takes precedence over crafting. When mining commands are active, crafting may reserve no more than 25% of the probe's total Mannys (rounded down); mining retains the other 75% or more.

Within that limited reserve, plan complete dependency chains without gating later units on observing each prior top-level output. Ready units of the earliest requested order may craft in parallel up to the reserve.

Later crafting orders and mining must not consume workers or item ingredients reserved for the earliest ready order. If the earliest order is not currently actionable, unrelated work may proceed.

Printer-only recipes are outside dependency expansion: queue them when directly requested, but ignore them when they are components of another recipe. Do not queue or inventory-gate those subcomponents before sending the final build order.

**Why:** Reserving every ready worker for crafting starved raw-material mining, including when resource-only recipes appeared ready but VNG rejected them for insufficient resources. Per-unit output gates also left allowed crafting capacity unused.

**How to apply:** Cap the crafting worker reserve at 25% of total Mannys, let every mining path claim the remainder first, then allocate the crafting slice to the earliest ready order. Preserve ingredient priority within that order and filter printer-only subrecipes from dependency traversal.