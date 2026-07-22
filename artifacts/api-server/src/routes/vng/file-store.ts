import { promises as fs } from "fs";
import path from "path";

/**
 * Resolved once and exported so callers that spawn a subprocess writing the same
 * store (the Claude brain's MCP server) can pass this exact absolute path down,
 * rather than each recomputing it against a different cwd.
 */
export const DATA_DIR = process.env['DATA_DIR']
  ? path.resolve(process.env['DATA_DIR'])
  : path.resolve(process.cwd(), "data");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readFile<T>(name: string, fallback: T): Promise<T> {
  const file = path.join(DATA_DIR, name);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * In-process write serializer. Every store mutation is a read-modify-write; two
 * running concurrently (e.g. a /state poll's recordSector racing a tool's
 * addContainer) would otherwise both read the old rows and the second write
 * would drop the first's change. Chaining them behind one promise removes that
 * lost-update race WITHIN this process.
 *
 * NOTE: this does NOT serialize across processes. The Claude brain runs tools in
 * a separate MCP subprocess that writes the same files; two processes can still
 * race a read-modify-write. The atomic write below prevents the worst outcome
 * (a torn read clobbering all rows), but full cross-process safety would need a
 * file lock and is out of scope here.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive regardless of this op's outcome.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

let tmpSeq = 0;

/**
 * Atomic replace: write to a unique temp file, then rename over the target.
 * A concurrent reader (in this or another process) sees either the old file or
 * the new one, never a half-written one — so a torn read can't feed an empty
 * fallback back into the next write and wipe the store. On Windows a rename over
 * a file another process briefly has open can transiently EPERM/EBUSY, so retry.
 */
async function writeFile<T>(name: string, data: T): Promise<void> {
  await ensureDir();
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp.${process.pid}.${tmpSeq++}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err: any) {
      const transient =
        err?.code === "EPERM" ||
        err?.code === "EBUSY" ||
        err?.code === "EACCES";
      if (attempt < 9 && transient) {
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
        continue;
      }
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

export type DetachedContainer = {
  id: number;
  containerId: string;        // inventory item ID (e.g. "container-itm_craft_xxx")
  sectorObjectId: string;     // sector object ID used for mining target & recovery: "detached-container-" + containerId
  containerName: string;
  mannyId: string;
  mannyName: string;
  sectorX: number;
  sectorY: number;
  sectorZ: number;
  detachedAt: string;
  status: "floating" | "recovered" | "unknown";
  anchorObjectId: string | null; // asteroid/planet object ID it is attached to (from sector after detach)
  anchorObjectName: string | null;
  notes: string | null;
};

// ── Pending / Deferred Actions ────────────────────────────────────────────────

export type ConditionMannyIdle = {
  type: "manny_idle";
  /** Omit to allow ANY idle Manny to pick up this task at fire time */
  mannyId?: string;
  mannyName?: string;
  /** Optional: also wait until ALL of these item types exist in probe inventory (for dependency chains) */
  requireItems?: string[];
};
export type ConditionProbeIdle = { type: "probe_idle" };
export type PendingCondition = ConditionMannyIdle | ConditionProbeIdle;

export type ActionMoveProbe       = { type: "move_probe"; x: number; y: number; z: number };
/** mannyId is optional — omit when scheduling via the crafting queue (any Manny picks it up at fire time) */
export type ActionCraftItem       = { type: "craft_item"; mannyId?: string; recipe: string };
export type ActionAtomicPrinterCraft = { type: "atomic_printer_craft"; recipe: string };
export type ActionMineResources   = { type: "mine_resources"; mannyId: string; objectId: string; resources: string[]; targetAmount: number; targetContainerId?: string };
export type ActionDetachContainer = { type: "detach_container"; mannyId: string; containerId: string };
export type ActionRecoverContainer = { type: "recover_container"; mannyId: string; objectId: string };
export type PendingActionPayload =
  | ActionMoveProbe
  | ActionCraftItem
  | ActionAtomicPrinterCraft
  | ActionMineResources
  | ActionDetachContainer
  | ActionRecoverContainer;

export type PendingAction = {
  id: number;
  description: string;
  createdAt: string;
  /** Which probe's Mannies/resources to use. null/absent = main probe (SnoozyBob). */
  probeId?: number | null;
  condition: PendingCondition;
  action: PendingActionPayload;
  status: "pending" | "triggered" | "failed";
  triggeredAt?: string;
  error?: string;
};

const PENDING_FILE = "pending-actions.json";

export async function getPendingActions(): Promise<PendingAction[]> {
  const all = await readFile<PendingAction[]>(PENDING_FILE, []);
  return all.filter((a) => a.status === "pending");
}

export async function addPendingAction(
  entry: Omit<PendingAction, "id" | "createdAt" | "status">
): Promise<PendingAction> {
  return withWriteLock(async () => {
    const rows = await readFile<PendingAction[]>(PENDING_FILE, []);
    const newRow: PendingAction = {
      ...entry,
      id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    rows.push(newRow);
    await writeFile(PENDING_FILE, rows);
    return newRow;
  });
}

export async function resolvePendingAction(
  id: number,
  result: { status: "triggered" | "failed"; error?: string }
): Promise<void> {
  return withWriteLock(async () => {
    const rows = await readFile<PendingAction[]>(PENDING_FILE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) {
      rows[idx].status = result.status;
      rows[idx].triggeredAt = new Date().toISOString();
      if (result.error) rows[idx].error = result.error;
      await writeFile(PENDING_FILE, rows);
    }
  });
}

export async function cancelPendingAction(id: number): Promise<boolean> {
  return withWriteLock(async () => {
    const rows = await readFile<PendingAction[]>(PENDING_FILE, []);
    const idx = rows.findIndex((r) => r.id === id && r.status === "pending");
    if (idx === -1) return false;
    rows.splice(idx, 1);
    await writeFile(PENDING_FILE, rows);
    return true;
  });
}

export type VisitedSector = {
  id: number;
  sectorX: number;
  sectorY: number;
  sectorZ: number;
  firstVisitedAt: string;
  lastVisitedAt: string;
  visitCount: number;
  objects: object[];
  resourceSummary: string[];
};

const CONTAINERS_FILE = "detached-containers.json";
const SECTORS_FILE = "visited-sectors.json";

/** Derive the sector object ID from an inventory container ID. */
export function toSectorObjectId(containerId: string): string {
  return `detached-container-${containerId}`;
}

export async function getContainers(): Promise<DetachedContainer[]> {
  return readFile<DetachedContainer[]>(CONTAINERS_FILE, []);
}

export async function addContainer(
  entry: Omit<DetachedContainer, "id" | "detachedAt">
): Promise<DetachedContainer> {
  return withWriteLock(async () => {
    const rows = await getContainers();
    const newRow: DetachedContainer = {
      ...entry,
      id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1,
      detachedAt: new Date().toISOString(),
    };
    rows.push(newRow);
    await writeFile(CONTAINERS_FILE, rows);
    return newRow;
  });
}

export async function updateContainerStatus(
  id: number,
  update: { status?: string; notes?: string }
): Promise<void> {
  return withWriteLock(async () => {
    const rows = await getContainers();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) {
      if (update.status) rows[idx].status = update.status as any;
      if (update.notes !== undefined) rows[idx].notes = update.notes;
      await writeFile(CONTAINERS_FILE, rows);
    }
  });
}

export async function updateContainerAnchor(
  id: number,
  anchorObjectId: string,
  anchorObjectName: string | null
): Promise<void> {
  return withWriteLock(async () => {
    const rows = await getContainers();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) {
      rows[idx].anchorObjectId = anchorObjectId;
      rows[idx].anchorObjectName = anchorObjectName;
      await writeFile(CONTAINERS_FILE, rows);
    }
  });
}

/**
 * Mark a container as recovered. Matches by sectorObjectId first,
 * then falls back to containerId (since the recovery tool uses the sector object ID).
 */
export async function markContainerRecovered(objectId: string): Promise<void> {
  return withWriteLock(async () => {
    const rows = await getContainers();
    let changed = false;
    for (const row of rows) {
      if (
        row.status === "floating" &&
        (row.sectorObjectId === objectId || row.containerId === objectId)
      ) {
        row.status = "recovered";
        changed = true;
      }
    }
    if (changed) await writeFile(CONTAINERS_FILE, rows);
  });
}

export async function getFloatingContainers(
  sectorX: number,
  sectorY: number,
  sectorZ: number
): Promise<DetachedContainer[]> {
  const rows = await getContainers();
  return rows.filter(
    (r) =>
      r.status === "floating" &&
      r.sectorX === sectorX &&
      r.sectorY === sectorY &&
      r.sectorZ === sectorZ
  );
}

export async function getSectors(): Promise<VisitedSector[]> {
  return readFile<VisitedSector[]>(SECTORS_FILE, []);
}

export async function recordSector(
  x: number,
  y: number,
  z: number,
  objects: object[]
): Promise<void> {
  const resourceSummary: string[] = Array.from(
    new Set((objects as any[]).flatMap((o) => o.resourceTypes ?? []))
  );

  // Store full object detail so the MAP tab can show everything
  const simplified = (objects as any[]).map((o) => {
    const base: Record<string, unknown> = {
      id: o.id ?? null,
      type: o.type,
      name: o.name ?? null,
      estimated: o.estimated ?? false,
      summary: o.summary ?? null,
      dangerLevel: o.dangerLevel ?? null,
      resourceTypes: o.resourceTypes ?? [],
    };

    // Solar system — keep star/planet list from bookmarkTargets
    if (o.type === "solar_system") {
      base.starCount = o.starCount ?? 0;
      base.planetCount = o.planetCount ?? 0;
      base.orbitalBodyCount = o.orbitalBodyCount ?? 0;
      base.bodies = (o.bookmarkTargets ?? []).map((b: any) => ({
        id: b.id,
        type: b.type,
        name: b.name ?? null,
        category: b.category ?? null,
        mass: b.mass,
        massUnit: b.massUnit,
        radius: b.radius,
        radiusUnit: b.radiusUnit,
        habitabilityScore: b.habitabilityScore ?? null,
        intelligentLife: b.intelligentLife ?? null,
      }));
    }

    // Planet
    if (o.type === "planet") {
      base.category = o.category ?? null;
      base.habitabilityScore = o.habitabilityScore ?? null;
      base.intelligentLife = o.intelligentLife ?? null;
      base.mass = o.mass ?? null;
      base.massUnit = o.massUnit ?? null;
      base.radius = o.radius ?? null;
      base.radiusUnit = o.radiusUnit ?? null;
    }

    // Asteroid
    if (o.type === "asteroid") {
      base.composition = o.composition ?? null;
      base.sizeCategory = o.sizeCategory ?? null;
      base.mass = o.mass ?? null;
      base.radius = o.radius ?? null;
      base.resourceAmounts = o.resourceAmounts ?? null;
      base.resourceComposition = o.resourceComposition ?? null;
    }

    // Detached container
    if (o.type === "detached_container") {
      base.capacity = o.capacity ?? null;
      base.mode = o.mode ?? null;
      base.targetObjectId = o.targetObjectId ?? null;
      base.salvageable = o.salvageable ?? false;
    }

    // SCUT relay — preserve range + network so the globe can draw coverage rings
    if (o.type === "scut_relay") {
      base.status = o.status ?? null;
      base.coverageRadiusSectors = o.coverageRadiusSectors ?? null;
      base.network = o.network ?? null;
      base.createdByProbeId = o.createdByProbeId ?? null;
      base.createdByProbeName = o.createdByProbeName ?? null;
      base.activatedAt = o.activatedAt ?? null;
    }

    // Star / black hole
    if (o.type === "star" || o.type === "black_hole") {
      base.mass = o.mass ?? null;
      base.massUnit = o.massUnit ?? null;
      base.radius = o.radius ?? null;
      base.radiusUnit = o.radiusUnit ?? null;
    }

    // Dust cloud / nebula
    if (o.type === "dust_cloud") {
      base.radius = o.radius ?? null;
      base.radiusUnit = o.radiusUnit ?? null;
    }

    return base;
  });

  return withWriteLock(async () => {
    const rows = await getSectors();
    const idx = rows.findIndex(
      (r) => r.sectorX === x && r.sectorY === y && r.sectorZ === z
    );

    const now = new Date().toISOString();
    if (idx !== -1) {
      rows[idx].lastVisitedAt = now;
      rows[idx].visitCount += 1;
      rows[idx].objects = simplified;
      rows[idx].resourceSummary = resourceSummary;
    } else {
      rows.push({
        id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1,
        sectorX: x,
        sectorY: y,
        sectorZ: z,
        firstVisitedAt: now,
        lastVisitedAt: now,
        visitCount: 1,
        objects: simplified,
        resourceSummary,
      });
    }
    await writeFile(SECTORS_FILE, rows);
  });
}
