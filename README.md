# Probe Commander

AI-powered natural language operator interface for [Von Neumann Game](https://neumann-probe.net).  
Type plain-English commands — the AI translates them into live API calls, schedules multi-step chains, and streams results back in real time.

Player: **SnoozyBob** · API version: **84** · Game version: **20260709-deuterium-transfer**

---

## What it does

| Tab | Description |
|---|---|
| **PROBE** | Live telemetry — fuel, hull integrity, Manny roster with task progress, movement ETA |
| **CNTRS** | On-board containers (capacity bars, green = full) and floating/asteroid-anchored containers |
| **MAP** | Visited sector log — planets, asteroids, solar systems, resources recorded on each visit |
| **SCOUT** | Remotely scan any sector by coordinates without travelling there |
| **GLOBE** | Interactive 3D sector sphere — probe position, home [0,0,0], prior departure, travel path |
| **SCHED** | View and cancel queued scheduled actions |

**AI Commander** — type anything into the chat input:
- *"What's in my inventory?"* → probe status summary
- *"Have all idle Mannies start building electric motors"* → fans out `craft_item` across idle Mannies
- *"Craft an additional container then detach it floating"* → sequential tool loop: `craft_item` → `detach_container`
- *"When Arendt finishes, have her build a steel plate"* → creates a `schedule_action` with `manny_idle` condition
- *"Activate the SCUT relay in this sector"* → `turn_on_relay` after `get_game_state` to resolve relay ID
- *"Send a message to probe 652 saying hello"* → `send_message`

---

## Stack

```
pnpm monorepo
├── artifacts/api-server         Express 5, esbuild (ESM bundle), port 8080
│   └── src/routes/vng/
│       ├── index.ts             Command endpoint + AI loop (SSE) + system prompt builder
│       ├── tools.ts             LLM tool definitions + executeTool()
│       ├── client.ts            VNG API client (neumann-probe.net)
│       ├── file-store.ts        JSON persistence (pending actions, visited sectors, containers)
│       ├── poller.ts            Background automation — fires scheduled actions on idle conditions
│       └── log.ts               Sector logging helpers
│   └── data/
│       ├── pending-actions.json Queued scheduled actions
│       └── visited-sectors.json Sector visit history + resource summaries
└── artifacts/probe-commander    React 19 + Vite 7 + Tailwind CSS v4 + TanStack Query, port 24340
    └── src/pages/
        ├── Commander.tsx        Entire frontend — all tabs, command input, SSE consumer
        └── GlobeMap.tsx         Canvas-based 3D sector globe
```

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces, Node.js 24, TypeScript 5.9 |
| API server | Express 5, esbuild bundle |
| Frontend | React 19, Vite 7, Tailwind CSS v4 |
| Data fetching | TanStack Query v5 |
| LLM | OpenAI-compatible via Replit AI Integrations proxy, model `gpt-5.4` |
| Streaming | Server-Sent Events on `POST /api/vng/command` |
| State | File-based JSON — no database |
| Logging | Pino + pino-http |

---

## Environment

| Secret | Purpose |
|---|---|
| `VNG_API_KEY` | Bearer token for neumann-probe.net game API |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Replit AI Integrations proxy base URL (set automatically) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Replit AI Integrations proxy key (set automatically) |

Set via Replit Secrets — never commit these values.

---

## Running

```bash
pnpm install

# API server (port 8080)
pnpm --filter @workspace/api-server run dev

# Frontend (port 24340)
pnpm --filter @workspace/probe-commander run dev

# Typecheck all packages
pnpm run typecheck
```

Both workflows are pre-configured in Replit and start automatically.

---

## API routes (port 8080)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/vng/command` | SSE stream — runs the AI tool-calling loop |
| `GET` | `/api/vng/state` | Current probe state snapshot |
| `GET` | `/api/vng/log/sectors` | Visited sectors with objects + resources |
| `GET` | `/api/vng/scheduled` | All pending scheduled actions |
| `DELETE` | `/api/vng/scheduled/:id` | Cancel a scheduled action |
| `GET` | `/api/vng/containers` | Tracked floating containers |
| `GET` | `/api/probe` | Raw VNG probe object (proxied) |

---

## AI tools

The LLM has access to these tools during a command turn:

### State

| Tool | What it does |
|---|---|
| `get_game_state` | Refresh probe / mannies / sector / inventory / recipes / probe improvements |

### Manny actions

| Tool | What it does |
|---|---|
| `craft_item` | Order a Manny to craft a recipe on their fabricator |
| `mine_resources` | Order a Manny to mine an asteroid or planet |
| `detach_container` | Detach a storage container (`mode`: `drifting` or `hidden_on_asteroid`) |
| `recover_container` | Recover a floating or anchored container back aboard |
| `inspect_sector_object` | Inspect an asteroid, drifting container, or dormant construct |
| `salvage_object` | Salvage a wreck or derelict in the sector |
| `repair_manny` | Restore a Manny's integrity (costs metals, 10 min / 1%) |
| `recall_manny` | Interrupt a Manny's current task and return it to idle |
| `rename_manny` | Rename a Manny |
| `deploy_manny` | Activate a stowed Manny from probe inventory |
| `drop_manny_cargo` | Discard cargo of a Manny stuck waiting outside for space, then retry docking |
| `turn_on_relay` | Activate an inactive SCUT relay (requires integrated_circuit + star in sector) |
| `install_waypoint_bookmark` | Place a named beacon on a sector object (requires `waypoint_bookmark` item) |
| `drop_container_on_planet` | Drop a container through atmosphere onto a planet (requires `atmospheric_drop_kit`) |

### Probe actions

| Tool | What it does |
|---|---|
| `move_probe` | Travel to a sector by coordinates |
| `atomic_printer_craft` | Run the Atomic 3D Printer (claims one Manny automatically) |
| `assemble_probe` | Assemble a new probe using 2 storage containers |
| `improve_probe` | Install a probe improvement (use `get_game_state` to see available improvements) |
| `refill_deuterium_tank` | Refuel from a deuterium refuel station in the current sector |
| `transfer_deuterium` | Transfer deuterium percentage to another probe in the same sector |
| `send_message` | Send a text message to a probe or inhabited planet |
| `scout_sector` | Remotely scan a sector without travelling |

### Automation

| Tool | What it does |
|---|---|
| `schedule_action` | Queue a future action with an idle condition |
| `cancel_scheduled_action` | Remove a queued scheduled action |

---

## Scheduled actions

Actions persist in `data/pending-actions.json`. The background poller checks every 30 seconds and fires any action whose condition is met:

- **`manny_idle`** — fires when the named Manny finishes its current task. Optional `requireItems` list blocks firing until those item types exist in probe inventory (used to guard cross-Manny dependencies in parallel builds).
- **`probe_idle`** — fires when the probe status is `idle`.

This enables fully automated multi-step crafting chains: schedule each subsequent step to fire on the previous Manny going idle, with `requireItems` ensuring assembled parts exist before the next recipe starts.

---

## Crafting

### Manny fabricator recipes

| Recipe | Notes |
|---|---|
| `steel_bar` | Raw material |
| `steel_plate` | Raw material |
| `electric_motor` | Uses steel + motor parts |
| `battery_pack` | |
| `linear_actuator` | |
| `deuterium_engine` | |
| `additional_container` | Extra probe storage |
| `solar_panel` | |
| `scut_relay` | Craftable unit — must be activated with `turn_on_relay` after deployment |
| `thermal_protection_shell` | Required for atmospheric entry |
| `parachute_pack` | Required for atmospheric drop |
| `descent_guidance_module` | Required for atmospheric drop |
| `atmospheric_drop_kit` | Assembled drop kit (combine the above) |
| `waypoint_bookmark` | Sector beacon |
| `manny` | Build a new Manny unit |

### Atomic Printer recipes

| Recipe | Notes |
|---|---|
| `micro_conductor` | Printer-only |
| `ceramic_insulator` | Printer-only |
| `crystal_substrate` | Printer-only |
| `dopant_matrix` | Printer-only |
| `integrated_circuit` | Printer-only — required to activate a SCUT relay |
| `atomic_printer_part` | Printer-only — spare/repair part for the printer itself |

> **Printer-only** items cannot be crafted by Mannies. The Atomic Printer automatically claims one Manny as its assistant when started — keep one unassigned when queuing printer jobs.

### Crafting notes

- **Ingredient data is exposed to the AI** — every recipe includes its full ingredient list so the AI can compute complete work breakdowns and distribute tasks across all Mannies.
- **Stock consumption order** — when a Manny crafts an assembled item, it consumes existing stock of sub-components first, then crafts any shortfall. Build higher-level items before their raw materials to avoid pre-built stock being silently consumed mid-build.
- **Parallel builds** — the AI is instructed to compute the full work breakdown first, then distribute it across all available Mannies with sequential chains per Manny, using `requireItems` to guard final assembly steps.

---

## SCUT relay activation

SCUT relays extend a network for long-range probe communication and remote Manny tasking across sectors.

1. Craft a `scut_relay` using a Manny fabricator (intermediate components needed).
2. Deploy it into the sector — it appears as a sector object with a purely numeric ID (e.g. `"42"`).
3. Ensure the sector contains a star (solar power source) and the probe has at least one `integrated_circuit` in inventory.
4. Use `turn_on_relay` with `relay_id: 42` (integer, parsed from the sector object ID string). Duration ~5 min.

Once active, the relay creates or extends a SCUT network. Probes on the same network can communicate via `send_message` and task Mannies remotely.

---

## Probe improvements

Probe improvements are permanent upgrades installed via `improve_probe`. Available improvements and their ingredient requirements are returned by `get_game_state` in the `probe_improvements` list.

Known improvements:
- **`deuterium_compression`** — reduces deuterium consumption during travel
- **`reinforced_container_couplings`** — increases the number of containers that can be attached

Some improvements are unlocked by inspecting dormant construct sector objects (`inspect_sector_object`).

---

## Deuterium operations

- **Refuel** — `refill_deuterium_tank`: sector must contain a `[deuterium_refuel_station]` object. One idle Manny required. Duration ~1 min.
- **Transfer** — `transfer_deuterium`: target probe must be visible as a `[probe]` sector object. `target_probe_id` is an integer (e.g. `652`). `amount` is the percentage points of deuterium to transfer (must be less than the probe's current reserve).

---

## Atmospheric drop

Drop a storage container of goods onto an inhabited planet in the current sector:

1. Craft `thermal_protection_shell`, `parachute_pack`, `descent_guidance_module` (Manny fabricator).
2. Craft `atmospheric_drop_kit` to assemble them.
3. Use `drop_container_on_planet` with the container inventory ID and planet sector object ID.

---

## Globe

The GLOBE tab renders a rotatable 3D sphere of the probe's known space using the HTML5 Canvas API.

- **◉ Probe** (green) — current sector, always centred
- **○ Prior** (yellow) — departure point from the last completed trip
- **⌂ Home [0,0,0]** (blue) — probe birth sector, always shown when in range (even if unvisited)
- **● Visited** (orange) — all logged sectors connected by a chronological travel-path line
- Drag to rotate · scroll/buttons to zoom (8 levels, 0.25×–5×) · click any dot to inspect
- Per-element brightness sliders — default 50%, where 50% = visually full brightness; slider runs to 100% for extra boost

---

## Notes

- **Relativistic transit** — while the probe is in faster-than-light travel, the VNG API blocks sector reads. The commander handles this gracefully; sector data is empty until arrival.
- **Stowed Mannies** — Mannies sitting in probe inventory (not yet deployed) appear in the PROBE telemetry and can be activated with `deploy_manny`.
- **Floating containers** — tracked locally with anchor asteroid, Manny name, and detach timestamp. Use the SECTOR OBJECT ID (not the inventory ID) when mining into or recovering a container.
- **`inspect_sector_object`** supersedes the deprecated `inspect_asteroid` — works on asteroids, drifting containers, and dormant constructs (which unlock probe improvements). Both names are accepted by the tool executor for backwards compatibility.
- **Messages** — `send_message` works for probes in the same sector or sharing a SCUT relay network, and for inhabited planets in the current sector. `recipient_id` is the numeric probe ID (e.g. `"652"`) or the planet's sector object ID.
