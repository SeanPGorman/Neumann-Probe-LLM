import { Router } from "express";
import { db, detachedContainers, visitedSectors } from "@workspace/db";
import { desc, and, eq } from "drizzle-orm";

const router = Router();

router.get("/containers", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(detachedContainers)
      .orderBy(desc(detachedContainers.detachedAt));
    res.json({ containers: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/containers/:id/status", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, notes } = req.body as { status?: string; notes?: string };
    const update: Record<string, unknown> = {};
    if (status) update.status = status;
    if (notes !== undefined) update.notes = notes;
    await db.update(detachedContainers).set(update).where(eq(detachedContainers.id, id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sectors", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(visitedSectors)
      .orderBy(desc(visitedSectors.lastVisitedAt));
    res.json({ sectors: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
