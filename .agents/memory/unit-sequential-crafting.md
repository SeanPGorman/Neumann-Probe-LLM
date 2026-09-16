---
name: Unit-sequential crafting
description: Preferred ordering and concurrency rules for multi-quantity crafting requests.
---

For a multi-quantity craft request, plan a complete dependency chain per requested output. All independently ready parts for the current output may craft in parallel, but the next output's parts remain gated until the prior top-level output exists.

**Why:** Globally batching every subcomponent creates large intermediate stockpiles, fills storage, and delays delivery of the first usable finished item.

**How to apply:** Allocate existing inventory to earlier units first, gate later units on cumulative top-level output counts, and reserve consumable item counts within each poll so concurrent jobs cannot claim the same components.