---
name: VNG container storage moves
description: Current container-loading and SCUT transit-beacon capabilities in the Von Neumann game API
---

**Rule:** VNG API v130 supports moving resources, items, and Mannies between onboard containers through the storage-moves operation. Additional-container hull items themselves cannot be moved through that operation.

**Why:** Earlier probing targeted guessed store/load paths and incorrectly concluded that crafted items could not be loaded. The live API schema now documents storage moves, container renaming/rules, and a separate SCUT transit-beacon installation operation.

**How to apply:** Use the live OpenAPI schema rather than guessed paths. Load cargo from the probe core into named onboard containers with an idle Manny, then detach/recover the containers for handoff. The container item type is `additional_container`; `integrated_circuit` is printer-only. A `scut_transit_beacon` is a distinct crafted item installed on an active relay, not a waypoint bookmark.
