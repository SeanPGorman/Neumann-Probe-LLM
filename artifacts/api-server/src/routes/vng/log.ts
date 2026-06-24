import { Router } from "express";
import {
  getContainers,
  getSectors,
  updateContainerStatus,
} from "./file-store.js";
import { getProbe, getSector } from "./client.js";

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

export default router;
