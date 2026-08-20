---
name: VNG Manny repair target
description: The VNG repair endpoint's actual target and how to handle partial metal inventories.
---

The VNG endpoint named `/api/probe/mannies/{mannyId}/repair` assigns a Manny to restore **probe hull integrity**. Its `integrityPercent` request value is the number of integrity percentage points to restore; each point takes ten real minutes and consumes 0.01 containers of metals.

**Why:** The client method and UI tool were named as though the endpoint repaired the Manny itself, which caused automation to gate repair work on Manny integrity instead of the probe's hull condition.

**How to apply:** When a probe's hull is damaged, read `probe.inventory.resourceStocks` for `metals`. Divide that amount by 0.01, cap it at the missing integrity, and request that exact repair amount with an idle Manny. Do not use cargo capacity or a fixed fallback size.