import { Router } from "express";
import {
  getMiningAssignments,
  upsertMiningAssignment,
  removeMiningAssignment,
  updateMiningCycleState,
} from "./file-store.js";
import { clientFor, parseProbeId } from "./client.js";

const router = Router();

// ── GET /api/vng/log/mining — assignments + sector context for the panel ──────
router.get("/mining", async (req, res) => {
  try {
    const probeId = parseProbeId(req.query.probeId);
    const c = clientFor(probeId);

    const [probeResp, manniesResp, sectorResp, assignments] = await Promise.all([
      c.getProbe().catch(() => null),
      c.getMannies().catch(() => null),
      c.getSector().catch(() => null),
      getMiningAssignments(),
    ]);

    const probe = probeResp?.probe ?? null;
    const probeAssignments = assignments.filter(
      (a) => (a.probeId ?? null) === (probeId ?? null)
    );

    // Inventory containers (on-board storage units)
    const inventoryContainers: any[] = (probe?.inventory?.containers ?? [])
      .filter((c: any) => c.kind === "container")
      .map((c: any) => ({
        id: c.id,
        label: c.label ?? c.id,
        capacity: c.capacity ?? 1,
        usedCapacity: c.usedCapacity ?? 0,
        freeCapacity: c.freeCapacity ?? 0,
      }));

    // Mannies with task detail
    const mannies: any[] = (manniesResp?.mannies ?? []).map((m: any) => ({
      id: m.id,
      name: m.name,
      currentTask: m.currentTask ?? null,
      taskProgressPercent: m.taskProgressPercent ?? null,
      taskDepositedAmount: m.task?.depositedAmount ?? null,
      taskTargetAmount: m.task?.targetAmount ?? null,
    }));

    // Asteroids from sector objects
    const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];
    const asteroids = sectorObjects
      .filter((o: any) => o.type === "asteroid")
      .map((o: any) => ({
        id: o.id,
        name: o.name ?? "Unnamed asteroid",
        resourceTypes: o.resourceTypes ?? [],
        composition: o.composition ?? null,
        sizeCategory: o.sizeCategory ?? null,
        mannyMineable: o.mannyMineable !== false,
      }));

    res.json({
      assignments: probeAssignments,
      asteroids,
      containers: inventoryContainers,
      mannies,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/vng/log/mining — create assignment ───────────────────────────────
router.post("/mining", async (req, res) => {
  try {
    const { containerId, containerName, material, mannyCount, probeId } = req.body;
    if (!containerId || !material) {
      res.status(400).json({ error: "containerId and material are required" });
      return;
    }
    const assignment = await upsertMiningAssignment({
      containerId,
      containerName: containerName ?? containerId,
      material,
      mannyCount: Math.max(1, parseInt(String(mannyCount ?? "4"), 10)),
      probeId: probeId != null ? Number(probeId) : null,
      enabled: true,
      cycleState: "idle",
    });
    res.json({ assignment });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/vng/log/mining/:id — update assignment ─────────────────────────
router.patch("/mining/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { material, mannyCount, enabled, containerName } = req.body;
    const assignments = await getMiningAssignments();
    const existing = assignments.find((a) => a.id === id);
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    const updated = await upsertMiningAssignment({
      ...existing,
      ...(material != null ? { material } : {}),
      ...(mannyCount != null ? { mannyCount: Math.max(1, parseInt(String(mannyCount), 10)) } : {}),
      ...(enabled != null ? { enabled: Boolean(enabled) } : {}),
      ...(containerName != null ? { containerName } : {}),
    });
    res.json({ assignment: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/vng/log/mining/:id ────────────────────────────────────────────
router.delete("/mining/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await removeMiningAssignment(id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/vng/log/mining/:id/reset — force cycle back to idle ──────────────
router.post("/mining/:id/reset", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await updateMiningCycleState(id, {
      cycleState: "idle",
      asteroidObjectId: undefined,
      miningMannyIds: [],
      lastError: undefined,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
