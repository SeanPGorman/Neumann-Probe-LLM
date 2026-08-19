---
name: VNG fuel field — raw vs state
description: Which field name to use for deuterium fuel depending on the data source
---

Raw VNG API (`getProbe()`) returns fuel as nested fields: `probe.fuel.deuterium` (current units) and `probe.fuel.maxDeuterium` (tank capacity).

Our `/api/vng/state` route (index.ts line 398) flattens it to `probe.fuelDeuterium`. Any code reading probe data via `getProbe()` (the poller, drone-role-runner) must use `probe?.fuel?.deuterium`. Code reading from our state endpoint response uses `fuelDeuterium`.

`fuel.deuterium` is in **absolute units** (not percentage 0–100). Use `fuel.deuterium / fuel.maxDeuterium * 100` for percentage-based automation. A generic probe has a 100-unit tank and a `deuterium_tanker` has a 400-unit tank before compression improvements.

**Why:** Confusing this caused the runner to fall back to 0 every tick, dispatching repeated refills and over-fueling FT-1 to 227 units. It also makes a raw-unit threshold incorrect for tanker fuel. The state endpoint masks the nested structure.

**How to apply:** When writing runner code that reads `probe` (from the poller/`getProbe()`), always use `probe?.fuel?.deuterium`. Never use `probe?.fuelDeuterium` in runner code — that field only exists on state-route responses.
