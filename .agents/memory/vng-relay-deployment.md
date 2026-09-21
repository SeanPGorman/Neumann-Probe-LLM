---
name: VNG SCUT relay deployment
description: How SCUT relays are deployed and how their state is reported in the VNG game API
---

SCUT relays deploy via **jettison**: there is no dedicated install action — jettisoning a `scut_relay` inventory item creates an inactive relay sector object. Deployment is legal only in a sector containing a sun/star.

Relay sector objects report state as `status: "off" | "on"`, **not** a boolean `active`.

**Why:** confirmed by the game's authoritative API behavior; earlier code assumed `active` and could never see a deployed relay, and unrestricted jettison attempted illegal placement in sunless sectors.

**How to apply:** inspect relay state via `status`; before jettisoning a relay item, verify a direct star or a star nested in solar-system bodies/targets, then activate with the turn-on-relay Manny action.
