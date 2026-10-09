---
name: Delivery automation scope
description: User-set boundaries for diagnosing and fixing Delivery drone automation.
---

Keep AI command handling unchanged. During diagnosis, do not manually mutate live game or role state. Conflicting scheduled actions must remain pending rather than being executed or failed.

Mining and drone-role automation run in the same probe poll. Share Manny claims between them; if role work gets a 409 conflict, queue a targeted retry for that probe instead of a global poll.

Treat scheduled-action 409 responses as retryable conflicts: leave the row pending and stop processing that probe until the next poll.

For factory-served couriers, return confirmed labeled surplus containers to Factory-1 intact rather than jettisoning them. Recover drifting surplus first, return one at a time only while co-located, and wait for active detach/recovery work. Do not treat a generic container label as proof that it is surplus.

**Why:** The user set these boundaries while troubleshooting Delivery drones.

**Why:** The user chose intact returns for surplus delivery containers; unlabeled containers are not confirmed surplus.

**Why:** Live Factory work can select a Manny already claimed earlier in the same poll, and a deferred 409 otherwise waits for the slow global role interval.

**Why:** A conflict means the selected Manny is busy now, not that the requested scheduled action is invalid.

**How to apply:** Limit fixes to role automation and its persisted state; use read-only live checks, preserve pending scheduled conflicts, scope role retries to affected probe IDs, and keep surplus cleanup within the user's container-return boundaries.
