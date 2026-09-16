---
name: Priority crafting
description: Preferred order priority and concurrency rules for multi-quantity crafting requests.
---

For a multi-quantity craft request, plan complete dependency chains, but do not gate later units on observing each prior top-level output. When sufficient Mannys and ingredients exist, all ready units of the earliest requested order may craft in parallel.

Later crafting orders and mining must not consume workers or item ingredients reserved for the earliest ready order. If the earliest order is not currently actionable, unrelated work may proceed.

Printer-only recipes are outside dependency expansion: queue them when directly requested, but ignore them when they are components of another recipe. Do not queue or inventory-gate those subcomponents before sending the final build order.

**Why:** Per-unit output gates left idle Mannys unused and delayed identical ready units. Loose global scheduling also allowed later steel-bar work or mining to take capacity needed to finish an earlier Manny order.

**How to apply:** Give each request an explicit order identity, allocate existing inventory to the earliest order first, reserve its consumable item counts and ready-worker count within each poll, and make every mining path honor that reserve. Filter printer-only subrecipes from dependency traversal and direct-item gates.