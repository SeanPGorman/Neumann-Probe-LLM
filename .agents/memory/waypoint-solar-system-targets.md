---
name: Waypoint bookmarks on solar-system bodies
description: How explorer waypoints identify mineable bodies and avoid duplicate beacons.
---

Build explorer waypoint labels and anchors from mapped solar-system bodies, not the raw sector object. VNG splits a body's bookmarkable identity and mineable resources between separate arrays, which must be merged before choosing a metal-asteroid anchor or counting resource categories. Do not place a waypoint in a sector that already has any waypoint bookmark.

**Why:** Raw sector data made a waypoint label show only the Deuterium source while omitting nested metal asteroids, and a revisit would otherwise consume another bookmark item for a duplicate beacon.

**How to apply:** Reuse the shared sector-object mapping before waypoint selection. Prefer a mapped asteroid with `metals`, include all mapped body resource types in the label, and check `waypointBookmarks` on the sector before assigning a Manny or using an inventory item.