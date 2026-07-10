const BASE = "https://neumann-probe.net";

function headers() {
  const key = process.env.VNG_API_KEY;
  if (!key) throw new Error("VNG_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function vngFetch(path: string, init: RequestInit = {}) {
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

const mannyPost = (mannyId: string, suffix: string, body: Record<string, unknown> = {}) =>
  vngPost(`/api/probe/mannies/${encodeURIComponent(mannyId)}/${suffix}`, body);

// ── Read-only endpoints ───────────────────────────────────────────────────────
export const getProbe            = () => vngFetch("/api/probe");
export const getMannies          = () => vngFetch("/api/probe/mannies");
export const getSector           = () => vngFetch("/api/probe/sector");
export const getCraftingRecipes  = () => vngFetch("/api/crafting-recipes");
export const getVisitedSectors   = () => vngFetch("/api/probe/visited-sectors");
export const getProbeList        = () => vngFetch("/api/probes");
export const getProbeImprovements = () => vngFetch("/api/probe/probe-improvements-available");
export const getMissions         = () => vngFetch("/api/probe/missions");
export const scanSector = (x: number, y: number, z: number) =>
  vngFetch(`/api/sector?x=${x}&y=${y}&z=${z}`);

// ── Probe-level actions ───────────────────────────────────────────────────────
export const moveProbe = (x: number, y: number, z: number) =>
  vngPost("/api/probe/move", { target: { x, y, z } });
export const deployManny = (itemId: string) =>
  vngPost("/api/probe/mannies", { itemId });
export const atomicPrinterCraft = (recipe: string) =>
  vngPost("/api/probe/atomic-printer/craft", { recipe });
export const jettisonItem = (inventoryId: string, amount?: number) =>
  vngPost(`/api/probe/inventory/${encodeURIComponent(inventoryId)}/jettison`,
    amount !== undefined ? { amount } : {});
export const sendMessage = (
  recipientType: "probe" | "planet",
  recipientId: number | string,
  body: string
) => vngPost("/api/probe/messages", { recipient: { type: recipientType, id: recipientId }, body });

// ── Manny actions ─────────────────────────────────────────────────────────────
export const craftItem = (mannyId: string, recipe: string) =>
  mannyPost(mannyId, "craft", { recipe });
export const mineResources = (
  mannyId: string,
  objectId: string,
  resources: string[],
  targetAmount: number,
  targetContainerId?: string
) => mannyPost(mannyId, "mine", {
  objectId, resources, targetAmount,
  ...(targetContainerId ? { targetContainerId } : {}),
});
export const repairManny = (mannyId: string, integrityPercent: number) =>
  mannyPost(mannyId, "repair", { integrityPercent });
export const recallManny    = (mannyId: string) => mannyPost(mannyId, "recall");
export const renameManny    = (mannyId: string, name: string) =>
  vngPatch(`/api/probe/mannies/${encodeURIComponent(mannyId)}`, { name });
export const salvageObject  = (mannyId: string, objectId: string) =>
  mannyPost(mannyId, "salvage", { objectId });
export const inspectSectorObject = (mannyId: string, objectId: string) =>
  mannyPost(mannyId, "inspect-sector-object", { objectId });
/** @deprecated Use inspectSectorObject instead */
export const inspectAsteroid = inspectSectorObject;
export const recoverContainer = (mannyId: string, objectId: string) =>
  mannyPost(mannyId, "recover-storage-container", { objectId });
export const dropContainerOnAsteroid = (mannyId: string, containerId: string, objectId: string) =>
  mannyPost(mannyId, "drop-storage-container", { containerId, objectId });
export const dropContainerOnPlanet = (mannyId: string, containerId: string, planetId: string) =>
  mannyPost(mannyId, "drop-storage-container", { containerId, planetId });
export const detachContainer = (
  mannyId: string,
  containerId: string,
  mode: "drifting" | "hidden_on_asteroid" = "drifting",
  asteroidObjectId?: string
) => mannyPost(mannyId, "detach-storage-container", {
  containerId, mode,
  ...(mode === "hidden_on_asteroid" && asteroidObjectId ? { objectId: asteroidObjectId } : {}),
});
export const refillDeuteriumTank = (mannyId: string) =>
  mannyPost(mannyId, "refill-deuterium-tank");
export const transferDeuteriumToProbe = (mannyId: string, targetProbeId: number, amount: number) =>
  mannyPost(mannyId, "transfer-deuterium-to-probe", { targetProbeId, amount });
export const assembleProbe = (mannyId: string, containerIds: string[]) =>
  mannyPost(mannyId, "assemble-probe", { containerIds });
export const improveProbe = (mannyId: string, improvement: string) =>
  mannyPost(mannyId, "improve-probe", { improvement });
export const installWaypointBookmark = (mannyId: string, objectId: string, name: string) =>
  mannyPost(mannyId, "install-bookmark", { objectId, name });
export const turnOnRelay = (mannyId: string, relayId: number, networkName?: string) =>
  mannyPost(mannyId, "turn-on-relay", { relayId, ...(networkName ? { networkName } : {}) });
export const dropMannyCargo = (mannyId: string) =>
  mannyPost(mannyId, "drop-manny-cargo");
