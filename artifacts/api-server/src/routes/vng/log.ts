import { Router } from "express";
import {
  getContainers,
  getSectors,
  updateContainerStatus,
  recordSector,
} from "./file-store.js";
import { getProbe, getSector, scanSector, getVisitedSectors } from "./client.js";
import { mapSectorObjects, sectorResourceSummary } from "./sector-map.js";

const router = Router();

// Debug: raw probe inventory structure — use this to inspect field names from the VNG API
router.get("/inventory-debug", async (_req, res) => {
  try {
    const probeResp = await getProbe();
    const inv = probeResp?.probe?.inventory ?? {};
    res.json({
      capacity: inv.capacity,
      usedCapacity: inv.usedCapacity,
      freeCapacity: inv.freeCapacity,
      containersCount: (inv.containers ?? []).length,
      itemsCount: (inv.items ?? []).length,
      containers: inv.containers ?? [],
      items: inv.items ?? [],
      resourceStocksCount: (inv.resourceStocks ?? []).length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/containers", async (_req, res) => {
  try {
    // Live sources: probe inventory (contents + capacity) + current sector objects
    const [probeResp, sectorResp, fileContainers] = await Promise.all([
      getProbe().catch(() => null),
      getSector().catch(() => null),
      getContainers(),
    ]);

    // Build contents map: inventoryContainerId → [{ resource, amount }]
    const contentsByContainerId = new Map<string, { resource: string; amount: number }[]>();
    const resourceStocks: any[] = probeResp?.probe?.inventory?.resourceStocks ?? [];
    for (const stock of resourceStocks) {
      for (const entry of stock.containers ?? []) {
        const cid: string = entry.container?.id;
        if (!cid) continue;
        if (!contentsByContainerId.has(cid)) contentsByContainerId.set(cid, []);
        contentsByContainerId.get(cid)!.push({ resource: stock.type, amount: entry.amount });
      }
    }

    // Build capacity map from probe inventory containers list
    const capacityByInventoryId = new Map<string, { used: number; total: number }>();
    for (const c of probeResp?.probe?.inventory?.containers ?? []) {
      capacityByInventoryId.set(c.id, { used: c.usedCapacity ?? 0, total: c.capacity ?? 1 });
    }

    // File-store lookup by sectorObjectId for metadata
    const fileByObjId = new Map(fileContainers.map((c: any) => [c.sectorObjectId, c]));

    // On-board containers (attached to probe): kind === "container" in inventory
    const inventoryContainers: any[] = (probeResp?.probe?.inventory?.containers ?? [])
      .filter((c: any) => c.kind === "container");

    const onboard = inventoryContainers.map((c: any) => ({
      id: c.id,
      containerName: c.label ?? c.id,
      status: "onboard",
      capacity: c.capacity ?? null,
      usedCapacity: c.usedCapacity ?? null,
      freeCapacity: c.freeCapacity ?? null,
      contents: contentsByContainerId.get(c.id) ?? [],
    }));

    // Floating containers: live sector detached_container objects
    const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];
    const sectorDetached = sectorObjects.filter((o: any) => o.type === "detached_container");

    const floating = sectorDetached.map((o: any) => {
      const inventoryId = o.id.replace(/^detached-container-/, "");
      const contents = contentsByContainerId.get(inventoryId) ?? [];
      const cap = capacityByInventoryId.get(inventoryId);
      const meta = fileByObjId.get(o.id);
      return {
        id: meta?.id ?? o.id,
        containerName: o.name ?? meta?.containerName ?? "Container",
        sectorObjectId: o.id,
        sectorX: meta?.sectorX ?? probeResp?.probe?.sector?.relative?.x ?? "?",
        sectorY: meta?.sectorY ?? probeResp?.probe?.sector?.relative?.y ?? "?",
        sectorZ: meta?.sectorZ ?? probeResp?.probe?.sector?.relative?.z ?? "?",
        anchorObjectId: o.targetObjectId ?? meta?.anchorObjectId ?? null,
        anchorObjectName: meta?.anchorObjectName ?? null,
        mode: o.mode ?? null,
        capacity: cap?.total ?? o.capacity ?? null,
        usedCapacity: cap?.used ?? null,
        status: "floating",
        detachedAt: meta?.detachedAt ?? null,
        mannyName: meta?.mannyName ?? null,
        notes: meta?.notes ?? null,
        contents,
      };
    });

    res.json({ onboard, floating });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/containers/:id/status", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, notes } = req.body as { status?: string; notes?: string };
    await updateContainerStatus(id, { status, notes });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sectors", async (_req, res) => {
  try {
    // Game API is authoritative for coordinates/timestamps/visitCount.
    // Local JSON supplements with scanned objects.
    const [gameResp, localSectors] = await Promise.all([
      getVisitedSectors().catch(() => null),
      getSectors().catch(() => []),
    ]);

    // Build local lookup by "x,y,z" key for objects
    const localByKey = new Map<string, any>();
    for (const s of localSectors as any[]) {
      localByKey.set(`${s.sectorX},${s.sectorY},${s.sectorZ}`, s);
    }

    let sectors: any[];
    if (gameResp?.visitedSectors?.length) {
      sectors = (gameResp.visitedSectors as any[]).map((gs) => {
        const x = gs.relativeCoordinates.x;
        const y = gs.relativeCoordinates.y;
        const z = gs.relativeCoordinates.z;
        const local = localByKey.get(`${x},${y},${z}`);
        return {
          sectorX: x,
          sectorY: y,
          sectorZ: z,
          firstVisitedAt: gs.firstVisitedAt,
          lastVisitedAt: gs.lastVisitedAt,
          visitCount: gs.visitCount,
          objects: local?.objects ?? [],
        };
      });
    } else {
      // Fallback to local JSON if game API is unavailable
      sectors = (localSectors as any[]).map((s) => ({
        sectorX: s.sectorX,
        sectorY: s.sectorY,
        sectorZ: s.sectorZ,
        firstVisitedAt: s.firstVisitedAt ?? s.lastVisitedAt,
        lastVisitedAt: s.lastVisitedAt,
        visitCount: s.visitCount,
        objects: s.objects ?? [],
      }));
    }

    sectors.sort(
      (a, b) =>
        new Date(b.lastVisitedAt).getTime() -
        new Date(a.lastVisitedAt).getTime()
    );

    res.json({ sectors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scan all visited sectors and store their objects — fixes stale/empty object lists.
// Fires concurrent scanSector calls (up to 12 sectors typically) and persists results.
router.post("/sectors/refresh", async (_req, res) => {
  try {
    const gameResp = await getVisitedSectors().catch(() => null);
    const visitedList: { x: number; y: number; z: number }[] = (
      gameResp?.visitedSectors ?? []
    ).map((gs: any) => ({
      x: gs.relativeCoordinates.x,
      y: gs.relativeCoordinates.y,
      z: gs.relativeCoordinates.z,
    }));

    if (!visitedList.length) {
      res.json({ refreshed: 0, sectors: [] });
      return;
    }

    // Scan all sectors concurrently, tolerate individual failures
    const results = await Promise.allSettled(
      visitedList.map(async ({ x, y, z }) => {
        const body = await scanSector(x, y, z);
        const rawObjects: any[] = body?.sector?.objects ?? [];
        const objects = mapSectorObjects(rawObjects);
        const resourceSummary = sectorResourceSummary(rawObjects);
        await recordSector(x, y, z, rawObjects);
        return { x, y, z, objectCount: objects.length, resourceSummary };
      })
    );

    const succeeded = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<any>).value);
    const failed = results.filter((r) => r.status === "rejected").length;

    res.json({ refreshed: succeeded.length, failed, sectors: succeeded });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scout any sector by coordinates without visiting it
router.get("/scout", async (req, res) => {
  try {
    const x = parseInt(req.query.x as string, 10);
    const y = parseInt(req.query.y as string, 10);
    const z = parseInt(req.query.z as string, 10);
    if (isNaN(x) || isNaN(y) || isNaN(z)) {
      res.status(400).json({ error: "x, y, z must be integers" });
      return;
    }
    if ((x + y + z) % 2 !== 0) {
      res.status(400).json({ error: "x + y + z must be even (game constraint)" });
      return;
    }

    const body = await scanSector(x, y, z);
    const rawObjects: any[] = body?.sector?.objects ?? [];

    const objects = mapSectorObjects(rawObjects);
    const resourceSummary = sectorResourceSummary(rawObjects);

    res.json({ x, y, z, objects, resourceSummary });
  } catch (err: any) {
    console.error(`[scout] failed for (${req.query.x},${req.query.y},${req.query.z}):`, err.message);
    // VNG rate-limits remote scans until the probe has sufficient dwell data —
    // surface this as a soft unavailability rather than a hard error.
    if (err.message.includes("not collected enough data")) {
      const retryIn = err.message.match(/Try again in (.+?)\.?\s*$/)?.[1] ?? null;
      res.json({ unavailable: true, retryIn });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
