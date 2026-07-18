import { Router } from "express";
import {
  getContainers,
  getSectors,
  updateContainerStatus,
  recordSector,
} from "./file-store.js";
import { getProbe, getSector, scanSector, getVisitedSectors, clientFor, getCraftingRecipes } from "./client.js";
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

router.get("/containers", async (req, res) => {
  try {
    const probeId = req.query.probeId ? Number(req.query.probeId) : null;
    const c = clientFor(probeId);
    // Live sources: probe inventory (contents + capacity) + current sector objects
    const [probeResp, sectorResp, fileContainers] = await Promise.all([
      c.getProbe().catch(() => null),
      c.getSector().catch(() => null),
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

    // Probe hull storage: total inventory minus the sum of attached container capacities
    const inv = probeResp?.probe?.inventory ?? {};
    const containerCapacityTotal = inventoryContainers.reduce((s: number, c: any) => s + (c.capacity ?? 0), 0);
    const containerUsedTotal = inventoryContainers.reduce((s: number, c: any) => s + (c.usedCapacity ?? 0), 0);
    const hullCapacity = (inv.capacity ?? 0) - containerCapacityTotal;
    const hullUsed = (inv.usedCapacity ?? 0) - containerUsedTotal;

    // Hull contents: resourceStocks amounts not allocated to any inventory container
    const containerIdSet = new Set(inventoryContainers.map((c: any) => c.id));
    const hullContents: { resource: string; amount: number }[] = [];
    for (const stock of resourceStocks) {
      const inContainers = (stock.containers ?? [])
        .filter((e: any) => containerIdSet.has(e.container?.id))
        .reduce((s: number, e: any) => s + (e.amount ?? 0), 0);
      const inHull = (stock.amount ?? 0) - inContainers;
      if (inHull > 0.0005) hullContents.push({ resource: stock.type ?? stock.name, amount: inHull });
    }

    // Inventory items stored in the hull (non-manny, non-printer)
    const inventoryItems: any[] = inv.items ?? [];
    const hullItems = inventoryItems
      .filter((i: any) => i.type !== "manny" && i.type !== "atomic_3d_printer")
      .map((i: any) => ({ name: i.label ?? i.name ?? i.type ?? i.id, type: i.type ?? "" }));

    const probeStorage = {
      capacity: hullCapacity,
      usedCapacity: hullUsed,
      freeCapacity: hullCapacity - hullUsed,
      contents: hullContents,
      items: hullItems,
    };

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

    res.json({ probeStorage, onboard, floating });
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

router.get("/crafting-calc", async (req, res) => {
  try {
    const probeId = req.query.probeId ? Number(req.query.probeId) : null;
    const c = clientFor(probeId);

    const [probeResp, recipesResp] = await Promise.all([
      c.getProbe().catch(() => null),
      getCraftingRecipes().catch(() => ({ recipes: [] })),
    ]);

    const inv = probeResp?.probe?.inventory ?? {};
    const resourceStocks: any[] = inv.resourceStocks ?? [];
    const inventoryItems: any[] = inv.items ?? [];

    // Count crafted items by type (exclude machines)
    const itemCountByType: Record<string, number> = {};
    for (const item of inventoryItems) {
      const type: string = item.type ?? item.id;
      if (type === "manny" || type === "atomic_3d_printer") continue;
      itemCountByType[type] = (itemCountByType[type] ?? 0) + 1;
    }

    // Resources currently available
    const resourceByType: Record<string, number> = {};
    for (const stock of resourceStocks) {
      resourceByType[stock.type] = stock.amount ?? 0;
    }

    const recipes: any[] = recipesResp.recipes ?? [];
    const recipeById = new Map<string, any>(recipes.map((r: any) => [r.id, r]));

    // Recursively calculate total crafting time for `quantity` of `recipeId`.
    // Mutates availableItems / availableResources so consumption cascades correctly.
    function calcTime(
      recipeId: string,
      quantity: number,
      availableItems: Record<string, number>,
      availableResources: Record<string, number>,
    ): { seconds: number; missingResources: { type: string; need: number; have: number }[] } {
      const recipe = recipeById.get(recipeId);
      if (!recipe) return { seconds: 0, missingResources: [] };

      const inStock = availableItems[recipeId] ?? 0;
      const toCraft = Math.max(0, quantity - inStock);
      availableItems[recipeId] = Math.max(0, inStock - quantity);

      if (toCraft === 0) return { seconds: 0, missingResources: [] };

      let totalSeconds = toCraft * (recipe.durationSeconds ?? 0);
      const missing: { type: string; need: number; have: number }[] = [];

      for (const ing of recipe.ingredients ?? []) {
        const needed: number = ing.quantity * toCraft;
        if (ing.kind === "resource") {
          const avail = availableResources[ing.type] ?? 0;
          availableResources[ing.type] = Math.max(0, avail - needed);
          if (avail < needed - 0.0001) {
            missing.push({ type: ing.type, need: needed, have: Math.min(avail, needed) });
          }
        } else {
          const sub = calcTime(ing.type, needed, availableItems, availableResources);
          totalSeconds += sub.seconds;
          missing.push(...sub.missingResources);
        }
      }

      return { seconds: totalSeconds, missingResources: missing };
    }

    const result = recipes.map((r: any) => {
      const availItems = { ...itemCountByType };
      const availRes = { ...resourceByType };

      const { seconds: totalTimeSeconds, missingResources: rawMissing } =
        calcTime(r.id, 1, availItems, availRes);

      // Ingredient-level display data
      const ingredients = (r.ingredients ?? []).map((ing: any) => {
        if (ing.kind === "resource") {
          const have = Math.min(resourceByType[ing.type] ?? 0, ing.quantity);
          const missing = Math.max(0, ing.quantity - (resourceByType[ing.type] ?? 0));
          return { ...ing, have, missing, satisfied: missing < 0.0001 };
        } else {
          const have = Math.min(itemCountByType[ing.type] ?? 0, ing.quantity);
          const missing = Math.max(0, ing.quantity - (itemCountByType[ing.type] ?? 0));
          return { ...ing, have, missing, satisfied: missing < 0.0001 };
        }
      });

      // Deduplicate missing resources across the full tree
      const missingByType = new Map<string, { type: string; need: number; have: number }>();
      for (const m of rawMissing) {
        const ex = missingByType.get(m.type);
        if (ex) { ex.need += m.need; ex.have += m.have; }
        else missingByType.set(m.type, { ...m });
      }

      // canCraftNow = all direct ingredients are already satisfied (resources available, items in stock)
      const canCraftNow = ingredients.every((ing: any) => ing.satisfied);

      return {
        id: r.id,
        name: r.name,
        craftableBy: r.craftableBy ?? [],
        durationSeconds: r.durationSeconds ?? 0,
        ingredients,
        canCraftNow,
        totalTimeSeconds,
        missingResources: [...missingByType.values()],
      };
    });

    res.json({
      recipes: result,
      inventory: { items: itemCountByType, resources: resourceByType },
    });
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
    if (
      err.message.includes("not collected enough data") ||
      err.message.includes("Insufficient data collection time")
    ) {
      const retryIn = err.message.match(/Try again in (.+?)\.?\s*$/)?.[1] ?? null;
      res.json({ unavailable: true, retryIn });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
