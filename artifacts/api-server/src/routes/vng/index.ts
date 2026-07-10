@ -1,64 +1,74 @@
import { Router } from "express";
import OpenAI from "openai";
import * as client from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import {
  addContainer,
  cancelPendingAction,
  markContainerRecovered,
  recordSector,
  toSectorObjectId,
  updateContainerAnchor,
  getFloatingContainers,
  getPendingActions,
} from "./file-store.js";
import { mapSectorObjects } from "./sector-map.js";

const router = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

function sse(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.get("/scheduled", async (_req, res) => {
  try {
    const actions = await getPendingActions();
    res.json({ actions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/scheduled/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await cancelPendingAction(id);
    if (ok) res.json({ ok: true });
    else res.status(404).json({ error: `No pending action with id ${id}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/state", async (_req, res) => {
  try {
    const [probeResp, manniesResp, sectorResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
      client.getSector().catch(() => null),  // unavailable during high-speed transit
    ]);

    const probe = probeResp.probe;
    const inv = probe.inventory ?? {};
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };
    const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];

    recordSector(sector.x, sector.y, sector.z, sectorObjects).catch(() => {});
    // getSector() yields null ONLY when it threw — transit or a real fetch
    // error — which is distinct from a successful-but-empty sector. Surface it
    // so the UI can show "data unavailable" instead of falsely claiming the
    // sector is empty.
    const sectorUnavailable = sectorResp === null;

    // Only persist a scan that actually succeeded. On a failed fetch
    // sectorObjects is [] — recording that would clobber the last-known-good
    // detail for this sector (visited-sectors store, read by the MAP/SECTORS
    // tabs) with an empty list. Skip it, and surface write errors.
    if (!sectorUnavailable)
      recordSector(sector.x, sector.y, sector.z, sectorObjects).catch((e) => console.error("[recordSector /state]", e));

    const mannies = (manniesResp.mannies ?? []).map((m: any) => {
      // A manny's `task` payload carries the fields the map needs to plot it:
@ -109,6 +119,7 @@ router.get("/state", async (_req, res) => {
      stowedMannies,
      sectorObjects: sectorObjectsMapped,
      otherProbes: sectorResp?.sector?.probes ?? [],
      sectorUnavailable,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
@ -147,7 +158,11 @@ router.post("/command", async (req, res) => {
    const resourceStocks: any[] = inv.resourceStocks ?? [];
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };

    recordSector(sector.x, sector.y, sector.z, sectorObjects).catch(() => {});
    // Only persist a scan that actually succeeded (see /state) — a failed
    // getSector() yields null → sectorObjects [], and recording that would
    // clobber the sector's last-known-good detail with an empty list.
    if (sectorResp !== null)
      recordSector(sector.x, sector.y, sector.z, sectorObjects).catch((e) => console.error("[recordSector /command]", e));

    const manniesById = new Map(mannies.map((m: any) => [m.id, m]));
    const itemsById = new Map(inventoryItems.map((i: any) => [i.id, i]));
