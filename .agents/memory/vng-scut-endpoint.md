---
name: VNG SCUT coverage check — correct data source
description: How to get SCUT relay coverage data (the global scut-networks VNG endpoint does not exist)
---

`/api/probe/scut-networks` returns **404** — this VNG API endpoint does not exist.

To check SCUT relay coverage programmatically from the runner:
1. Call `getSectors()` from `file-store.ts` to get locally cached visited-sector data.
2. Collect unique network IDs from sector objects where `obj.type === "scut_relay" && obj.network?.id`.
3. For each network ID call `getScutNetwork(id)` from `client.ts` (this IS a valid endpoint).
4. From each network response, read `net.relays[]` with fields: `relay.sector.relative.{x,y,z}`, `relay.status` ("on"|"off"), `relay.coverageRadiusSectors`.

**Why:** the global endpoint was assumed to exist but never did. The local `/api/vng/scut-networks` route in `log.ts` replicates this exact aggregation pattern and serves as the reference implementation.

**How to apply:** any code that needs to know whether a sector is within SCUT relay coverage must use the `getSectors` + `getScutNetwork` pattern, not a direct VNG call. SCUT relay status is `"on"` (not `active: true`) — see vng-relay-deployment.md.
