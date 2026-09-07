---
name: Mining assignment migration
description: Safe procedure for permanently moving Mining assignments between probes.
---

When migrating Mining assignments, snapshot and leave active cycles untouched. Temporarily disable eligible idle assignments, transfer their containers to the destination probe, transfer only Mannys that were idle at the snapshot, then change assignment ownership and restore the original enabled state.

**Why:** Reassigning records before physical container custody makes automation fail, while leaving idle assignments enabled during a long transfer allows the poller to start new work and changes the safe migration set.

**How to apply:** Verify co-location and destination custody at each stage. Exclude containers with active crafting reservations or housed busy Mannys, and never cancel busy Manny tasks to complete a migration.