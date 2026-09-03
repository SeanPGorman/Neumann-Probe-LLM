import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./file-store.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DroneRoleType = "refuel" | "delivery" | "explorer" | "factory";

export type RefuelConfig = {
  /** Sector where deuterium is sourced (e.g. a planet with a refuel station). */
  sourceSector: { x: number; y: number; z: number };
  /** Probe used as the destination-sector anchor for the refuel service. */
  targetProbeId: number;
  targetProbeName?: string;
  /** Service eligible drones whose fuel is below this threshold. Default 80. */
  minFuelThreshold?: number;
};

export type DeliveryConfig = {
  /** Probe ID of the factory where containers are loaded. */
  factoryProbeId: number;
  factoryProbeName?: string;
};

export type ExplorerConfig = {
  /** Long-range destination. Explorer moves sector-by-sector in this direction. */
  targetVector: { x: number; y: number; z: number };
  /** SCUT network name to use when activating relays. */
  scutNetworkName?: string;
  /** Player / pilot name embedded in waypoint bookmark names. */
  playerName?: string;
  /** Starting WP counter override (defaults to 1). */
  wpStartNumber?: number;
};

export type FactoryConfig = {
  /** Probe IDs of the Delivery Drones this factory keeps supplied. */
  deliveryProbeIds: number[];
  deliveryProbeNames?: string[];
};

export type RoleState = {
  /** Current automation phase for this role. */
  phase: string;
  lastError?: string;
  lastUpdated?: string;
  /** Delivery request ID the explorer is waiting on (explorer role). */
  deliveryRequestId?: number;
  /** Sector the probe is currently travelling towards (refuel / explorer). */
  travelTarget?: { x: number; y: number; z: number };
  /** Explorer: sector we most recently finished deploying at. */
  lastDeployedSector?: { x: number; y: number; z: number };
  /** Delivery: explorer probe ID this drone is currently serving. */
  assignedExplorerId?: number;
  /** Factory: delivery probe ID currently being resupplied. */
  servingDeliveryProbeId?: number;
  /** Factory: sector object ID of the container staged (drifting) for pickup. */
  stagedContainerObjectId?: string;
  /** Explorer: sequential WP counter — increments each time a waypoint bookmark is installed. */
  wpCounter?: number;
  /** Refuel: last observed fuel level of the target probe (absolute units). */
  lastTargetFuel?: number;
  /** Refuel: last observed target fuel as a share of that probe's live tank. */
  lastTargetFuelPercent?: number;
  /** Refuel: eligible probe currently claimed for a transfer. */
  servingTargetProbeId?: number;
  servingTargetProbeName?: string;
  /** Delivery: the three fresh factory containers which may be sent onward. */
  outboundContainerIds?: string[];
  /** Factory: stable IDs of the containers being prepared for the current courier. */
  preparedContainerIds?: string[];
  /** Factory: labels keyed by delivery cargo class, retained across ticks/restarts. */
  deliveryContainerManifest?: { resources?: string; deployment?: string; metals?: string };
  /** Explorer: relay for which the transit beacon action has been requested. */
  beaconRelayId?: string;
};

export type DroneRole = {
  id: number;
  probeId: number;
  probeName?: string;
  roleType: DroneRoleType;
  enabled: boolean;
  createdAt: string;
  config: RefuelConfig | DeliveryConfig | ExplorerConfig | FactoryConfig;
  state: RoleState;
};

export type DeliveryRequest = {
  id: number;
  explorerId: number;
  explorerName?: string;
  explorerSector: { x: number; y: number; z: number };
  status: "pending" | "assigned" | "completed";
  assignedDeliveryProbeId?: number;
  createdAt: string;
};

// ── Internal file I/O ─────────────────────────────────────────────────────────

const ROLES_FILE            = "drone-roles.json";
const DELIVERY_REQUESTS_FILE = "delivery-requests.json";

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  const file = path.join(DATA_DIR, name);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(name: string, data: T): Promise<void> {
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// ── Drone Roles CRUD ──────────────────────────────────────────────────────────

export async function getDroneRoles(): Promise<DroneRole[]> {
  return readJson<DroneRole[]>(ROLES_FILE, []);
}

export async function getDroneRoleByProbeId(probeId: number): Promise<DroneRole | null> {
  const all = await getDroneRoles();
  return all.find((r) => r.probeId === probeId && r.enabled) ?? null;
}

export async function addDroneRole(
  entry: Omit<DroneRole, "id" | "createdAt" | "state">,
): Promise<DroneRole> {
  return withLock(async () => {
    const rows = await readJson<DroneRole[]>(ROLES_FILE, []);
    const defaultPhase: string = entry.roleType === "delivery" ? "waiting" : "idle";
    const newRow: DroneRole = {
      ...entry,
      id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1,
      createdAt: new Date().toISOString(),
      state: { phase: defaultPhase },
    };
    rows.push(newRow);
    await writeJson(ROLES_FILE, rows);
    return newRow;
  });
}

export async function updateDroneRole(
  id: number,
  patch: Partial<Omit<DroneRole, "id" | "createdAt">>,
): Promise<DroneRole | null> {
  return withLock(async () => {
    const rows = await readJson<DroneRole[]>(ROLES_FILE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    await writeJson(ROLES_FILE, rows);
    return rows[idx];
  });
}

export async function updateDroneRoleState(
  id: number,
  statePatch: Partial<RoleState>,
): Promise<void> {
  return withLock(async () => {
    const rows = await readJson<DroneRole[]>(ROLES_FILE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows[idx].state = {
      ...rows[idx].state,
      ...statePatch,
      lastUpdated: new Date().toISOString(),
    };
    await writeJson(ROLES_FILE, rows);
  });
}

/** Claim a refuel recipient so another tanker cannot start a duplicate transfer. */
export async function claimRefuelTarget(
  roleId: number,
  targetProbeId: number,
  targetProbeName?: string,
): Promise<boolean> {
  return withLock(async () => {
    const rows = await readJson<DroneRole[]>(ROLES_FILE, []);
    const idx = rows.findIndex((r) => r.id === roleId && r.roleType === "refuel" && r.enabled);
    if (idx === -1) return false;

    const claimedByAnotherRefueler = rows.some(
      (r) =>
        r.id !== roleId &&
        r.enabled &&
        r.roleType === "refuel" &&
        r.state.servingTargetProbeId === targetProbeId,
    );
    if (claimedByAnotherRefueler) return false;

    rows[idx].state = {
      ...rows[idx].state,
      phase: "transferring",
      servingTargetProbeId: targetProbeId,
      servingTargetProbeName: targetProbeName,
      lastUpdated: new Date().toISOString(),
    };
    await writeJson(ROLES_FILE, rows);
    return true;
  });
}

export async function deleteDroneRole(id: number): Promise<boolean> {
  return withLock(async () => {
    const rows = await readJson<DroneRole[]>(ROLES_FILE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    await writeJson(ROLES_FILE, rows);
    return true;
  });
}

// ── Delivery Requests ─────────────────────────────────────────────────────────

export async function getDeliveryRequests(): Promise<DeliveryRequest[]> {
  return readJson<DeliveryRequest[]>(DELIVERY_REQUESTS_FILE, []);
}

export async function getPendingDeliveryRequest(): Promise<DeliveryRequest | null> {
  const all = await getDeliveryRequests();
  return all.find((r) => r.status === "pending") ?? null;
}

export async function addDeliveryRequest(
  entry: Omit<DeliveryRequest, "id" | "createdAt" | "status">,
): Promise<DeliveryRequest> {
  return withLock(async () => {
    const rows = await readJson<DeliveryRequest[]>(DELIVERY_REQUESTS_FILE, []);
    const newRow: DeliveryRequest = {
      ...entry,
      id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    rows.push(newRow);
    await writeJson(DELIVERY_REQUESTS_FILE, rows);
    return newRow;
  });
}

export async function updateDeliveryRequest(
  id: number,
  patch: Partial<DeliveryRequest>,
): Promise<void> {
  return withLock(async () => {
    const rows = await readJson<DeliveryRequest[]>(DELIVERY_REQUESTS_FILE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows[idx] = { ...rows[idx], ...patch };
    await writeJson(DELIVERY_REQUESTS_FILE, rows);
  });
}

export async function deleteDeliveryRequest(id: number): Promise<boolean> {
  return withLock(async () => {
    const rows = await readJson<DeliveryRequest[]>(DELIVERY_REQUESTS_FILE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    await writeJson(DELIVERY_REQUESTS_FILE, rows);
    return true;
  });
}
