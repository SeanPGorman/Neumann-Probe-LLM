---
name: Craft retry call budget
description: Prevent blocked crafting queues from exhausting the shared VNG API request allowance.
---

A craft attempt must claim its Manny, or the Atomic Printer, before sending the request and retain that claim for the rest of the poll even when the request fails.

**Why:** An insufficient-resource response previously left the worker available, so one poll reused the same Manny across dozens of queued rows and exhausted the bearer token's minute-level API allowance.

**How to apply:** Treat attempted actions as consuming same-tick worker capacity regardless of outcome and coalesce duplicate reads within a poll. Throttle all account traffic from response rate-limit headers, reserve safety headroom, serialize cold-start discovery, and use conservative pacing when headers are unavailable.