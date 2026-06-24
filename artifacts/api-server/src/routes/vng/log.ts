import { Router } from "express";
import {
  getContainers,
  getSectors,
  updateContainerStatus,
} from "./file-store.js";
import { getProbe } from "./client.js";

const router = Router();

router.get("/containers", async (_req, res) => {
  try {
    const [containers, probeResp] = await Promise.all([
      getContainers(),
      getProbe().catch(() => null),
    ]);

    // Build a map: inventoryContainerId → array of { resource, amount }
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

    // Attach contents to each tracked container
    const enriched = containers.slice().reverse().map((c) => {
      // sectorObjectId = "detached-container-<inventoryId>"
      const inventoryId = c.sectorObjectId?.replace(/^detached-container-/, "") ?? null;
      const contents = inventoryId ? (contentsByContainerId.get(inventoryId) ?? []) : [];
      return { ...c, contents };
    });

    res.json({ containers: enriched });
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
