---
name: Ball Explorer repair reserve
description: Ball Explorer repair metals, low-hull emergency mining, and beaconed return rules
---

Ball Explorers require the full missile loadout and a full metals container before departure, but a partially depleted metals container remains a usable repair reserve while they are away. Repairs may consume that reserve; an empty reserve triggers return routing through an active SCUT transit beacon to the factory.

Ball Explorer fuel returns begin at or below 50% tank capacity. Persist the route stage: first reach an active transit beacon through covered SCUT sectors, then continue waypoint routing to the assigned factory. At the factory, wait until the assigned refuel role raises fuel above the threshold before resuming. Continue targeted role polls during the return and refuel wait.

When hull integrity falls below 25%, emergency metals mining may use only an unused, empty onboard container. Preserve the repair-reserve container and every assigned or otherwise protected container. Low-fuel return takes priority. Once hull integrity reaches 25%, stop dispatching miners, recover any deployed container, then resume the Ball Explorer's previous phase.

**Why:** The game API exposed no dependable per-hop fuel-cost estimate, so the 50% threshold is a conservative fixed reserve, not a guarantee for every possible route. Persisting the beacon-to-factory stage prevents each poll from sending the probe back toward the nearest beacon after it has already begun the home leg.

**Why:** Treating the metals container as a permanent full-loadout gate stopped Ball Explorers during normal hull repairs and prevented them from returning for resupply.

**Why:** The user chose an unused empty onboard container for emergency mining and explicitly asked to preserve the repair reserve and other protected containers.

**How to apply:** Do not block away-sector movement merely because the metals container is below capacity. Permit automatic hull repair to inspect onboard storage metals for Ball Explorers, and only initiate that return when the reserve reaches zero. For emergency mining, never take the reserve or an assigned/protected container; recover the active container before resuming. For deuterium returns, preserve the staged beacon-to-factory route and wait at home for refueling to clear the threshold.