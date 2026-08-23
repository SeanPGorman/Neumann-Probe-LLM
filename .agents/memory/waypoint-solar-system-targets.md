---
name: Waypoint bookmarks on SCUT relays
description: How explorer waypoints use solar-system resources while being installed on SCUT relays.
---

Build explorer waypoint labels from mapped solar-system bodies, not the raw sector object. VNG splits a body's bookmarkable identity and mineable resources between separate arrays, which must be merged before counting resource categories. The waypoint itself belongs on an activated SCUT relay, not on an asteroid or other celestial object. Do not place a waypoint in a sector that already has any waypoint bookmark.

**Why:** Raw sector data made a waypoint label show only the Deuterium source while omitting nested metal asteroids, and the explorer could previously place a beacon and request delivery before deploying a relay.

**How to apply:** Continue moving while the next hop is SCUT-covered. When the next hop is outside coverage, deploy and activate a relay, then install a waypoint on that relay. Reuse the shared sector-object mapping for resource totals, and check `waypointBookmarks` before assigning a Manny or using an inventory item.