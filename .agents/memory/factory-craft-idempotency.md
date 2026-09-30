---
name: Factory craft idempotency
description: Prevent repeated manifest-item crafting when output is unavailable until an asynchronous Manny job completes.
---

Factory automation must account for in-flight Manny crafts before retrying a missing item. The VNG task snapshot reports a generic crafting state without identifying the recipe, so a missing inventory count cannot distinguish an absent job from an unfinished one.

**Why:** Periodic checks can otherwise start the same long-running craft on another idle Manny every time, producing a large surplus before the first result appears.

**How to apply:** In recurrent factory workflows, serialize Manny item crafts while a craft is in progress, or persist a pending recipe and reconcile it against inventory after completion. Do not infer recipe completion from inventory alone.