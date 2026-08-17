---
name: VNG containers cannot hold crafted items
description: What storage containers can and cannot carry in the Von Neumann game API
---

**Rule:** The VNG API has no endpoint to move inventory items into a storage container. Container contents are *resources only* (filled via `mine` with `targetContainerId`). Probed and confirmed 404 for store/load/move-item style endpoints.

**Why:** A "load the container with crafted items" design is impossible; supplies only travel with a probe if they exist in that probe's own inventory. The Factory role therefore crafts supply items directly aboard the target drone via `clientFor(droneId)` (remote craft/printer).

**How to apply:** Any feature that needs to hand crafted items to another probe must craft aboard the recipient (or accept the item stays put). Also: the live container item type is `additional_container` (recipe name too), not `storage_container`; `integrated_circuit` is printer-only (`atomicPrinterCraft`), and "transit beacon" = `waypoint_bookmark`.
