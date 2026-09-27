---
name: Ball Explorer anomaly retrace
description: Safety reasoning for returning a Ball Explorer to a discovery it passed.
---

Retrace a missed discovery through a persisted route that selects the next hop from the probe's actual sector, and stop at the discovery without resuming exploratory movement.

**Why:** Independent `probe_idle` move orders are not a safe itinerary: if an earlier order fails, later orders can still execute from the wrong sector. Movement may already be in flight when the operator pauses a role, so the return must wait for arrival and tolerate a restart.

**How to apply:** Check each next recorded hop for adjacency and current SCUT coverage; hold rather than choosing a different route if the probe is off-path or coverage has changed. Keep the anomaly location visible until operator review.