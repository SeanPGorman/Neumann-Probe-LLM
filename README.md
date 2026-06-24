# Probe Commander

AI-powered cockpit for **Von Neumann Probe #51** ("Sonde de SnoozyBob") on [neumann-probe.net](https://neumann-probe.net).

Type natural language commands — the AI translates them into game API calls via a tool-calling loop, executes them in sequence, and streams live status back to you.

---

## What it does

| Tab | Description |
|---|---|
| **PROBE** | Live telemetry — fuel, hull integrity, Manny roster, movement ETA |
| **CNTRS** | On-board containers (contents + capacity bars) and floating/asteroid-anchored containers |
| **MAP** | Visited sector log — planets, asteroids, solar systems stored on each visit |
| **SCOUT** | Scan any arbitrary sector by coordinates without travelling there |

**AI Commander** — type anything into the chat:
- *"What's happening?"* → probe status summary
- *"Send a Manny to mine deuterium from the asteroid"* → `mine_resources` tool call
- *"Store all full containers on asteroids using available Mannies"* → fans out `drop_container_on_asteroid` across idle Mannies
- *"Craft an additional container then detach it"* → sequential tool loop: `craft_item` → `detach_container`

---

## Stack

```
pnpm monorepo
├── artifacts/api-server      Express 5, esbuild, port 8080
│   └── src/routes/vng/
│       ├── index.ts          State endpoint + AI command loop (SSE)
│       ├── tools.ts          Tool definitions + executor
│       ├── client.ts         VNG API client (neumann-probe.net)
│       ├── log.ts            /log/* routes: containers, sectors, scout
│       └── file-store.ts     JSON persistence (visited-sectors, containers)
└── artifacts/probe-commander React 19 + Vite + Tailwind 4 + TanStack Query
    └── src/pages/Commander.tsx   Entire frontend (single file)
```

**AI:** OpenAI tool-calling loop (gpt-4o). Tools stream results back via Server-Sent Events.

**Storage:** JSON files only — `data/visited-sectors.json`, `data/detached-containers.json`. No database.

---

## Environment

| Secret | Required | Purpose |
|---|---|---|
| `VNG_API_KEY` | ✓ | Bearer token for neumann-probe.net game API |

---

## Running locally

```bash
pnpm install

# API server (port 8080)
pnpm --filter @workspace/api-server run dev

# Frontend (port 24340)
pnpm --filter @workspace/probe-commander run dev
```

---

## AI tools available

| Tool | What it does |
|---|---|
| `get_game_state` | Full probe + Manny + sector + inventory snapshot |
| `move_probe` | Travel to sector coordinates |
| `mine_resources` | Send Manny to mine asteroid/planet |
| `craft_item` | Order Manny to fabricate an item |
| `atomic_printer_craft` | Run the on-board atomic 3D printer |
| `detach_container` | Drop a container floating in the sector |
| `drop_container_on_asteroid` | Hide a container on a specific asteroid |
| `recover_container` | Retrieve a floating/anchored container |
| `salvage_object` | Salvage abandoned objects |
| `inspect_asteroid` | Reveal asteroid composition and resources |
| `repair_manny` | Restore Manny integrity |
| `recall_manny` | Cancel a Manny's current task |
| `rename_manny` | Rename a Manny |
| `scan_sector` | Remote sector scan (no travel required) |
| `jettison_item` | Discard inventory items |

---

## Notes

- **Relativistic transit:** While the probe is cruising, the game blocks all sensor reads. The commander handles this gracefully — commands still work, sector data is just empty until arrival.
- **Asteroid details:** Composition and resource amounts require a Manny to physically `inspect_asteroid`. The SCOUT tab shows mass/radius from the sector scan; resources unlock after inspection.
- **Floating containers:** Tracked in `detached-containers.json` with anchor asteroid, Manny name, and detach timestamp.
