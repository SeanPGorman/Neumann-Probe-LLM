---
name: Refuel role persistence
description: How to diagnose refuel automation that appears to skip a known station.
---

Check the active drone-role store before changing the refuel state machine. A refueler without an enabled `refuel` role never reaches the source/refilling phases, even if it travels through a sector containing a deuterium refuel station.

**Why:** A merge removed FT-1's stored role assignment, so the existing refill command path was never invoked despite the source station being valid.

**How to apply:** When a tanker seems to leave a source without refueling, first inspect the active role returned by the drone-roles API and confirm its source sector and enabled status. Restore a known assignment through the API rather than altering the station-command logic unless the role and phase are present.