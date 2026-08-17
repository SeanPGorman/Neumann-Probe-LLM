---
name: VNG probe sector coordinates
description: Where probe coordinates actually live in the API response, and the even-sum sector constraint
---

Probe sector coordinates are at `probe.sector.relative.{x,y,z}` — NOT `probe.sector.x` directly.

`probe.sector` is an object with a `relative` sub-object. Accessing `probe.sector.x` gives `undefined`, which NaN-propagates through arithmetic and serialises to `null` in JSON logs.

**Why:** confirmed by `tools.ts` and `index.ts` which consistently use `probe.sector?.relative ?? { x:0,y:0,z:0 }`. The runner initially used `probe.sector` directly and generated null coordinates every tick.

**How to apply:** anywhere the runner or poller needs a probe's current sector coords, use `probe?.sector?.relative ?? null`. Same applies when reading another probe's sector via `getProbe()`: `resp?.probe?.sector?.relative ?? null`.

---

VNG sectors only exist at coordinates where **x + y + z is even**. Stepping all three axes simultaneously changes the sum by an odd amount (always invalid). The `nextSectorToward` helper must step **exactly two axes per hop** (net ±2 change in sum), chosen as the two axes with the largest remaining delta. A zero-delta axis gets a ±1 "detour" step that the next hop corrects. Because target and current both have even sums, total remaining delta is always even, guaranteeing convergence without infinite loops.
