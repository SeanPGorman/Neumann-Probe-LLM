---
name: Mining target planet filter
description: VNG rejects hidden_on_asteroid container deployment on planets — only asteroid-type bodies are valid; filter required in poller.
---

## Rule
When building the `asteroids` array from solar_system `minableTargets`, skip any body where `body.type !== "asteroid"`. Planets appear in `minableTargets` and have resourceTypes, but VNG rejects `detach-storage-container` with `mode: "hidden_on_asteroid"` on a planet with 422 "Hidden containers must be attached to an asteroid in the current sector."

**Why:** VNG's `minableTargets` mixes planets and asteroids. Planets are mineable via a different mechanism (`drop-storage-container` to planet). The `hidden_on_asteroid` mode is asteroid-only. Without the filter, the poller picks the first body matching the material — often a planet — and hammers VNG with 422s until the assignment is auto-disabled.

**How to apply:** In `poller.ts` `runMiningAutomation`, the solar_system body loop must `continue` when `body.type !== "asteroid"` before pushing to the `asteroids` array. This is already in place as of 2026-08-13.
