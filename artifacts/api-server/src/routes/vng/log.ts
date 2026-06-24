import { Router } from "express";
import {
  getContainers,
  getSectors,
  updateContainerStatus,
} from "./file-store.js";

const router = Router();

router.get("/containers", async (_req, res) => {
  try {
    const containers = await getContainers();
    res.json({ containers: containers.slice().reverse() });
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
