---
name: VNG SCUT relay deployment
description: How SCUT relays are deployed and how their state is reported in the VNG game API
---

SCUT relays deploy via **jettison**: there is no dedicated install action — jettisoning a `scut_relay` inventory item creates an inactive relay sector object.

Relay sector objects report state as `status: "off" | "on"`, **not** a boolean `active`.

**Why:** confirmed by the game's authoritative API spec at `https://neumann-probe.net/openapi.yaml`; earlier code assumed `active` and could never see a deployed relay. Check that spec before guessing endpoints or field shapes.

**How to apply:** any code inspecting relay sector objects must match on `status`; deploy relays by jettisoning the item, then activate with the turn-on-relay Manny action.
