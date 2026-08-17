---
name: VNG fuel field — raw vs state
description: Which field name to use for deuterium fuel depending on the data source
---

Raw VNG API (`getProbe()`) returns fuel as a **nested field**: `probe.fuel.deuterium`.

Our `/api/vng/state` route (index.ts line 398) flattens it to `probe.fuelDeuterium`. Any code reading probe data via `getProbe()` (the poller, drone-role-runner) must use `probe?.fuel?.deuterium`. Code reading from our state endpoint response uses `fuelDeuterium`.

`fuel.deuterium` is in **absolute units** (not percentage 0–100). A `deuterium_tanker` model has a larger tank than a standard probe (observed: 227 units while SnoozyBob peaks around 100). The `>= 99` check in `refilling` is "do we have at least 99 units" — fine for the small-probe case but may need per-model tuning later.

**Why:** Confusing this caused the runner to fall back to 0 every tick, dispatching repeated refills and over-fueling FT-1 to 227 units. Took significant debugging to identify because the state endpoint masks the nested structure.

**How to apply:** When writing runner code that reads `probe` (from the poller/`getProbe()`), always use `probe?.fuel?.deuterium`. Never use `probe?.fuelDeuterium` in runner code — that field only exists on state-route responses.
