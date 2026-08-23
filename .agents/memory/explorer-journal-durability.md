---
name: Explorer journal durability
description: Rules for preserving explorer discoveries and waypoint history through partial scans and scan failures.
---

Explorer journal records must retain a cumulative canonical raw discovery view, then derive the UI object projection and findings from that view. Later VNG scans can be partial, so missing fields must never erase an earlier resource, intelligent-life finding, alert, or danger signal. Merge object arrays only by stable IDs; retain anonymous signal records by content.

**Why:** Sector responses can omit discoveries observed on earlier polls. Replacing the stored snapshot makes historical reconnaissance unreliable.

**How to apply:** When adding scan fields or VNG object shapes, preserve the raw values and extend the cumulative merge before projecting to UI-friendly sector objects. Waypoint events must create a `scanAvailable: false` journal entry if no successful scan exists; a later scan enriches that same entry without removing its events.