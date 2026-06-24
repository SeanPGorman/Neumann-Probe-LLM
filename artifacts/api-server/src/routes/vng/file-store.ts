import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");

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

async function writeFile<T>(name: string, data: T): Promise<void> {
  await ensureDir();
  const file = path.join(DATA_DIR, name);
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
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
  const rows = await getContainers();
  const newRow: DetachedContainer = {
    ...entry,
    id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1,
    detachedAt: new Date().toISOString(),
  };
  rows.push(newRow);
  await writeFile(CONTAINERS_FILE, rows);
  return newRow;
}

export async function updateContainerStatus(
  id: number,
  update: { status?: string; notes?: string }
): Promise<void> {
  const rows = await getContainers();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx !== -1) {
    if (update.status) rows[idx].status = update.status as any;
    if (update.notes !== undefined) rows[idx].notes = update.notes;
    await writeFile(CONTAINERS_FILE, rows);
  }
}

export async function updateContainerAnchor(
  id: number,
  anchorObjectId: string,
  anchorObjectName: string | null
): Promise<void> {
  const rows = await getContainers();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx !== -1) {
    rows[idx].anchorObjectId = anchorObjectId;
    rows[idx].anchorObjectName = anchorObjectName;
    await writeFile(CONTAINERS_FILE, rows);
  }
}

/**
 * Mark a container as recovered. Matches by sectorObjectId first,
 * then falls back to containerId (since the recovery tool uses the sector object ID).
 */
export async function markContainerRecovered(objectId: string): Promise<void> {
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
  const simplified = (objects as any[]).map((o) => ({
    id: o.id ?? null,
    type: o.type,
    name: o.name ?? null,
    summary: o.summary ?? null,
    resourceTypes: o.resourceTypes ?? [],
  }));

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
}
