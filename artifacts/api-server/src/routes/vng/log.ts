import { Router } from "express";
import {
  getContainers,
  getSectors,
  updateContainerStatus,
} from "./file-store.js";
import { getProbe, getSector, scanSector } from "./client.js";

const router = Router();

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
    const sectors = await getSectors();
    res.json({
      sectors: sectors
        .slice()
        .sort(
          (a, b) =>
            new Date(b.lastVisitedAt).getTime() -
            new Date(a.lastVisitedAt).getTime()
        ),
    });
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

    const objects = rawObjects.map((o: any) => {
      const base: Record<string, unknown> = {
        id: o.id ?? null,
        type: o.type,
        name: o.name ?? null,
        summary: o.summary ?? null,
        dangerLevel: o.dangerLevel ?? null,
        resourceTypes: o.resourceTypes ?? [],
      };
      if (o.type === "solar_system") {
        base.starCount = o.starCount ?? 0;
        base.planetCount = o.planetCount ?? 0;
        base.orbitalBodyCount = o.orbitalBodyCount ?? 0;
        base.bodies = (o.bookmarkTargets ?? []).map((b: any) => ({
          id: b.id, type: b.type, name: b.name ?? null,
          category: b.category ?? null, mass: b.mass, massUnit: b.massUnit,
          radius: b.radius, radiusUnit: b.radiusUnit,
          habitabilityScore: b.habitabilityScore ?? null,
          intelligentLife: b.intelligentLife ?? null,
        }));
      }
      if (o.type === "planet") {
        base.category = o.category ?? null;
        base.habitabilityScore = o.habitabilityScore ?? null;
        base.intelligentLife = o.intelligentLife ?? null;
        base.mass = o.mass ?? null; base.massUnit = o.massUnit ?? null;
      }
      if (o.type === "asteroid") {
        base.composition = o.composition ?? null;
        base.sizeCategory = o.sizeCategory ?? null;
        base.resourceAmounts = o.resourceAmounts ?? null;
      }
      if (o.type === "detached_container") {
        base.capacity = o.capacity ?? null;
        base.mode = o.mode ?? null;
        base.targetObjectId = o.targetObjectId ?? null;
        base.salvageable = o.salvageable ?? false;
      }
      return base;
    });

    const resourceSummary: string[] = Array.from(
      new Set(rawObjects.flatMap((o: any) => o.resourceTypes ?? []))
    );

    res.json({ x, y, z, objects, resourceSummary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
