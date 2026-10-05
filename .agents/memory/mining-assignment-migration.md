---
name: Mining assignment migration
description: Safe procedure for permanently moving Mining assignments between probes.
---

When migrating Mining assignments, snapshot and leave active cycles untouched. Temporarily disable eligible idle assignments, transfer their containers to the destination probe, transfer only Mannys that were idle at the snapshot, then change assignment ownership and restore the original enabled state.

Do not use a container reserved by an enabled Mining assignment as unrelated factory staging or source stock, even when that assignment is currently idle.

**Why:** Reassigning records before physical container custody makes automation fail, leaving idle assignments enabled during a long transfer allows new work to start, and an automated factory move can consume stock from an enabled-but-idle Mining container.

**How to apply:** Verify co-location and destination custody at each stage. Exclude Mining-assigned containers from unrelated source selection, as well as containers with active crafting reservations or housed busy Mannys. Never cancel busy Manny tasks to complete a migration.