---
name: Probe-idle movement phases
description: Safe idle detection for deferred probe movement orders.
---

A probe is not idle while its status or movement status is `preparing`, `accelerating`, `cruising`, `decelerating`, or `moving`.

**Why:** Checking only for `moving` caused deferred travel orders to fire during preparation, fail with an already-moving conflict, and be marked failed instead of waiting for arrival.

**How to apply:** Use the complete movement-status set for scheduled `probe_idle` conditions and permit at most one probe movement order per polling cycle.