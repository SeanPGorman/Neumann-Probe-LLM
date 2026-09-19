---
name: Delivery jump safety
description: Safety invariant for routine and emergency delivery-drone routing.
---

All delivery travel, including emergency supply, must use the shared waypoint router. A move outside active relay-to-relay travel may span at most two sectors.

**Why:** An emergency courier issued a direct ten-sector move because the shared travel phase called the final target directly. The relay router also selected destination relays without first proving the courier was currently at an active source relay.

**How to apply:** Use a direct move only within Chebyshev distance two. Permit a longer move only when the current sector and destination sector contain active relays on the same SCUT network; otherwise issue one parity-safe short hop.