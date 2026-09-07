---
name: Relay beacons and celestial waypoints
description: Correct targets for SCUT transit beacons and explorer waypoint bookmarks.
---

Build explorer waypoint labels from mapped solar-system bodies, not the raw sector object. VNG splits a body's bookmarkable identity and mineable resources between separate arrays, which must be merged before counting resource categories. Install the SCUT transit beacon on the activated relay. Install the waypoint bookmark on a celestial object, preferably the sector's star. Do not place a waypoint in a sector that already has any waypoint bookmark.

**Why:** Raw sector data omitted nested metal asteroids from waypoint labels, and relay IDs are valid for transit-beacon installation but are not valid celestial waypoint targets.

**How to apply:** Continue moving while the next hop is SCUT-covered. When the next hop is outside coverage, deploy and activate a relay, install its transit beacon, then install the waypoint bookmark on a mapped celestial target. Reuse mapped solar-system bodies for resource totals and check for an existing sector waypoint first.