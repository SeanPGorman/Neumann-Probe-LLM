---
name: API routing — /api vs /api-server
description: Correct URL prefix for client-side fetches to the api-server in probe-commander
---

The api-server artifact has `paths = ["/api"]` in its artifact.toml. The Replit proxy routes `/api/*` directly to port 8080 (api-server). It does NOT route `/api-server/api/*` to port 8080 — that prefix goes to the probe-commander's Vite dev server (port 24340), which returns HTML for unknown paths.

**Rule:** All client-side fetches from probe-commander to the api-server must use:
```
fetch(`${BASE}/api/vng/...`)   // ✓ correct — reaches port 8080
fetch(`${BASE}/api-server/api/vng/...`)  // ✗ wrong — returns HTML from Vite
```

where `BASE = import.meta.env.BASE_URL.replace(/\/$/, "")` = `""` (since BASE_PATH="/").

**Why:** The Replit multi-artifact proxy uses the artifact's `paths` config to determine routing. The api-server declares `paths = ["/api"]`, so only requests starting with `/api` reach it. `/api-server/*` is not in its paths and falls through to the default artifact (probe-commander Vite dev server).

**How to apply:** Whenever adding a new fetch to the api-server from probe-commander client code, always use `${BASE}/api/vng/<endpoint>`, matching the existing state query pattern (`fetch(\`${BASE}/api/vng/state\`)`). The `GLOBE_BASE` constant (which was `BASE + "/api-server"`) was a bug — it was removed.

Also: `cache: "no-store"` is needed on the sectors fetch to prevent the browser from caching a stale HTML response from before the URL was fixed.
