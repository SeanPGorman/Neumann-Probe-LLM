---
name: Emergency courier loadout recovery
description: Why emergency delivery dispatch must reconcile live courier cargo instead of trusting factory container IDs.
---

Emergency supply dispatch must recognize the resource, deployment, and metals containers actually aboard the courier by their contents. A factory's persisted container IDs may become stale as soon as containers are handed off or manually replaced.

**Why:** A courier had the required cargo aboard, but dispatch remained blocked because the factory still referenced containers as though they were attached to the factory. One replacement metals container also had a different ID. VNG can report a nominal 0.50 metals resource allocation as 0.49, so exact decimal checks can reject a valid manifest.

**How to apply:** For emergency orders, reconcile semantic cargo classes against the courier's live storage, tolerate the observed one-hundredth resource variance, rebuild stale factory preparation state, and finish isolated missing manifest items aboard the courier when a handoff was incomplete.