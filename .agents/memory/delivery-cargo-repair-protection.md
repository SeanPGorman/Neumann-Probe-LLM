---
name: Protect delivery cargo from repairs
description: Prevent automatic courier repair from consuming factory-staged delivery metals.
---

Factory-served delivery probes must not use onboard mission cargo for automatic hull repair. Keep the exact staged resources and full metals containers intact from factory handoff through explorer delivery.

**Why:** Automatic repair can reserve or consume the delivery manifest's metals after pickup, silently leaving the explorer's resupply short even though the factory prepared it correctly.

**How to apply:** Skip generic automatic repair for factory-served couriers, validate exact resource composition and the full metals container before dispatch, and leave already accepted repair jobs alone unless the operator explicitly directs otherwise.