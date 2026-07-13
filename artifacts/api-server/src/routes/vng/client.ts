const BASE = "https://neumann-probe.net";

function headers() {
  const key = process.env.VNG_API_KEY;
  if (!key) throw new Error("VNG_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function vngFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...((init.headers as Record<string, string>) ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) {
    const msg =
      (body as any)?.error?.message ??
      (body as any)?.message ??
      res.statusText;
    throw new Error(`VNG API error (${res.status}): ${msg}`);
  }
  return body;
}

const vngPost = (path: string, body: Record<string, unknown> = {}) =>
  vngFetch(path, { method: "POST", body: JSON.stringify(body) });

const vngPatch = (path: string, body: Record<string, unknown>) =>
  vngFetch(path, { method: "PATCH", body: JSON.stringify(body) });

// ── Probe-scoped client factory ───────────────────────────────────────────────
// Returns a full set of client functions scoped to a specific probe (by numeric
// ID) or to the operator's main probe (when probeId is null / undefined).
export function clientFor(probeId?: number | null) {
  const base = probeId != null ? `/api/probe/${probeId}` : `/api/probe`;
  const mPost = (mannyId: string, suffix: string, body: Record<string, unknown> = {}) =>
    vngPost(`${base}/mannies/${encodeURIComponent(mannyId)}/${suffix}`, body);

  return {
    getProbe:       () => vngFetch(base),
    getMannies:     () => vngFetch(`${base}/mannies`),
    getSector:      () => vngFetch(`${base}/sector`),
    getProbeImprovements: () => vngFetch(`${base}/probe-improvements-available`),

    moveProbe:      (x: number, y: number, z: number) =>
      vngPost(`${base}/move`, { target: { x, y, z } }),
    deployManny:    (itemId: string) =>
      vngPost(`${base}/mannies`, { itemId }),
    atomicPrinterCraft: (recipe: string) =>
      vngPost(`${base}/atomic-printer/craft`, { recipe }),
    jettisonItem:   (inventoryId: string, amount?: number) =>
      vngPost(`${base}/inventory/${encodeURIComponent(inventoryId)}/jettison`,
        amount !== undefined ? { amount } : {}),
    sendMessage:    (recipientType: "probe" | "planet", recipientId: number | string, msgBody: string) =>
      vngPost(`${base}/messages`, { recipient: { type: recipientType, id: recipientId }, body: msgBody }),

    craftItem:      (mannyId: string, recipe: string) =>
      mPost(mannyId, "craft", { recipe }),
    mineResources:  (mannyId: string, objectId: string, resources: string[], targetAmount: number, targetContainerId?: string) =>
      mPost(mannyId, "mine", { objectId, resources, targetAmount, ...(targetContainerId ? { targetContainerId } : {}) }),
    repairManny:    (mannyId: string, integrityPercent: number) =>
      mPost(mannyId, "repair", { integrityPercent }),
    recallManny:    (mannyId: string) => mPost(mannyId, "recall"),
    renameManny:    (mannyId: string, name: string) =>
      vngPatch(`${base}/mannies/${encodeURIComponent(mannyId)}`, { name }),
    salvageObject:  (mannyId: string, objectId: string) =>
      mPost(mannyId, "salvage", { objectId }),
    inspectSectorObject: (mannyId: string, objectId: string) =>
      mPost(mannyId, "inspect-sector-object", { objectId }),
    recoverContainer: (mannyId: string, objectId: string) =>
      mPost(mannyId, "recover-storage-container", { objectId }),
    dropContainerOnAsteroid: (mannyId: string, containerId: string, objectId: string) =>
      mPost(mannyId, "drop-storage-container", { containerId, objectId }),
    detachContainer: (mannyId: string, containerId: string, mode: "drifting" | "hidden_on_asteroid" = "drifting", asteroidObjectId?: string) =>
      mPost(mannyId, "detach-storage-container", {
        containerId, mode,
        ...(mode === "hidden_on_asteroid" && asteroidObjectId ? { objectId: asteroidObjectId } : {}),
      }),
    refillDeuteriumTank: (mannyId: string) =>
      mPost(mannyId, "refill-deuterium-tank"),
    transferDeuteriumToProbe: (mannyId: string, targetProbeId: number, amount: number) =>
      mPost(mannyId, "transfer-deuterium-to-probe", { targetProbeId, amount }),
    assembleProbe:  (mannyId: string, containerIds: string[]) =>
      mPost(mannyId, "assemble-probe", { containerIds }),
    improveProbe:   (mannyId: string, improvement: string) =>
      mPost(mannyId, "improve-probe", { improvement }),
    installWaypointBookmark: (mannyId: string, objectId: string, name: string) =>
      mPost(mannyId, "install-bookmark", { objectId, name }),
    dropContainerOnPlanet: (mannyId: string, containerId: string, planetId: string) =>
      mPost(mannyId, "drop-storage-container", { containerId, planetId }),
    turnOnRelay:    (mannyId: string, relayId: number, networkName?: string) =>
      mPost(mannyId, "turn-on-relay", { relayId, ...(networkName ? { networkName } : {}) }),
    dropMannyCargo: (mannyId: string) =>
      mPost(mannyId, "drop-manny-cargo"),
  };
}

// ── Convenience aliases (main probe) ─────────────────────────────────────────
const main = () => clientFor(null);

export const getProbe            = () => main().getProbe();
export const getMannies          = () => main().getMannies();
export const getSector           = () => main().getSector();

// Parameterized probe endpoints — used for owned probes / drones
export const getProbeById   = (id: number) => clientFor(id).getProbe();
export const getManniesById = (id: number) => clientFor(id).getMannies();
export const getSectorById  = (id: number) => clientFor(id).getSector();

// Global (not probe-scoped) endpoints
export const getCraftingRecipes  = () => vngFetch("/api/crafting-recipes");
export const getVisitedSectors   = () => vngFetch("/api/probe/visited-sectors");
export const getProbeList        = () => vngFetch("/api/probes");
export const getProbeImprovements = () => main().getProbeImprovements();
export const getMissions         = () => vngFetch("/api/probe/missions");
export const scanSector = (x: number, y: number, z: number) =>
  vngFetch(`/api/sector?x=${x}&y=${y}&z=${z}`);

// ── Main-probe action aliases (used by poller.ts and legacy callers) ──────────
export const moveProbe = (x: number, y: number, z: number) => main().moveProbe(x, y, z);
export const deployManny = (itemId: string) => main().deployManny(itemId);
export const atomicPrinterCraft = (recipe: string) => main().atomicPrinterCraft(recipe);
export const jettisonItem = (inventoryId: string, amount?: number) => main().jettisonItem(inventoryId, amount);
export const sendMessage = (
  recipientType: "probe" | "planet",
  recipientId: number | string,
  body: string
) => main().sendMessage(recipientType, recipientId, body);

export const craftItem = (mannyId: string, recipe: string) => main().craftItem(mannyId, recipe);
export const mineResources = (
  mannyId: string,
  objectId: string,
  resources: string[],
  targetAmount: number,
  targetContainerId?: string
) => main().mineResources(mannyId, objectId, resources, targetAmount, targetContainerId);
export const repairManny = (mannyId: string, integrityPercent: number) => main().repairManny(mannyId, integrityPercent);
export const recallManny    = (mannyId: string) => main().recallManny(mannyId);
export const renameManny    = (mannyId: string, name: string) => main().renameManny(mannyId, name);
export const salvageObject  = (mannyId: string, objectId: string) => main().salvageObject(mannyId, objectId);
export const inspectSectorObject = (mannyId: string, objectId: string) => main().inspectSectorObject(mannyId, objectId);
/** @deprecated Use inspectSectorObject instead */
export const inspectAsteroid = inspectSectorObject;
export const recoverContainer = (mannyId: string, objectId: string) => main().recoverContainer(mannyId, objectId);
export const dropContainerOnAsteroid = (mannyId: string, containerId: string, objectId: string) => main().dropContainerOnAsteroid(mannyId, containerId, objectId);
export const dropContainerOnPlanet = (mannyId: string, containerId: string, planetId: string) => main().dropContainerOnPlanet(mannyId, containerId, planetId);
export const detachContainer = (
  mannyId: string,
  containerId: string,
  mode: "drifting" | "hidden_on_asteroid" = "drifting",
  asteroidObjectId?: string
) => main().detachContainer(mannyId, containerId, mode, asteroidObjectId);
export const refillDeuteriumTank = (mannyId: string) => main().refillDeuteriumTank(mannyId);
export const transferDeuteriumToProbe = (mannyId: string, targetProbeId: number, amount: number) => main().transferDeuteriumToProbe(mannyId, targetProbeId, amount);
export const assembleProbe = (mannyId: string, containerIds: string[]) => main().assembleProbe(mannyId, containerIds);
export const improveProbe = (mannyId: string, improvement: string) => main().improveProbe(mannyId, improvement);
export const installWaypointBookmark = (mannyId: string, objectId: string, name: string) => main().installWaypointBookmark(mannyId, objectId, name);
export const turnOnRelay = (mannyId: string, relayId: number, networkName?: string) => main().turnOnRelay(mannyId, relayId, networkName);
export const dropMannyCargo = (mannyId: string) => main().dropMannyCargo(mannyId);
