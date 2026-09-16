---
name: Unit-sequential crafting
description: Preferred ordering and concurrency rules for multi-quantity crafting requests.
---

For a multi-quantity craft request, plan a complete dependency chain per requested output. All independently ready parts for the current output may craft in parallel, but the next output's parts remain gated until the prior top-level output exists.

Printer-only recipes are outside dependency expansion: queue them when directly requested, but ignore them when they are components of another recipe. Do not queue or inventory-gate those subcomponents before sending the final build order.

**Why:** Globally batching every subcomponent creates large intermediate stockpiles, fills storage, and delays delivery of the first usable finished item.

**How to apply:** Allocate existing inventory to earlier units first, gate later units on cumulative top-level output counts, reserve consumable item counts within each poll, and filter printer-only subrecipes from dependency traversal and direct-item gates.