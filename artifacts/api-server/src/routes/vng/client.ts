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

/** Returns probe object including probe.inventory */
export async function getProbe() {
  return vngFetch("/api/probe");
}

export async function getMannies() {
  return vngFetch("/api/probe/mannies");
}

export async function getSector() {
  return vngFetch("/api/probe/sector");
}

export async function getCraftingRecipes() {
  return vngFetch("/api/crafting-recipes");
}

export async function scanSector(x: number, y: number, z: number) {
  return vngFetch(`/api/sector?x=${x}&y=${y}&z=${z}`);
}

export async function moveProbe(x: number, y: number, z: number) {
  return vngFetch("/api/probe/move", {
    method: "POST",
    body: JSON.stringify({ target: { x, y, z } }),
  });
}

export async function craftItem(mannyId: string, recipe: string) {
  return vngFetch(`/api/probe/mannies/${encodeURIComponent(mannyId)}/craft`, {
    method: "POST",
    body: JSON.stringify({ recipe }),
  });
}

export async function mineResources(
  mannyId: string,
  objectId: string,
  resources: string[],
  targetAmount: number,
  targetContainerId?: string
) {
  const body: Record<string, unknown> = { objectId, resources, targetAmount };
  if (targetContainerId) body.targetContainerId = targetContainerId;
  return vngFetch(`/api/probe/mannies/${encodeURIComponent(mannyId)}/mine`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function repairManny(mannyId: string, integrityPercent: number) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/repair`,
    {
      method: "POST",
      body: JSON.stringify({ integrityPercent }),
    }
  );
}

export async function recallManny(mannyId: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/recall`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
}

export async function renameManny(mannyId: string, name: string) {
  return vngFetch(`/api/probe/mannies/${encodeURIComponent(mannyId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

/** Deploy a manny from probe inventory into active service. itemId is the inventory item ID of the manny. */
export async function deployManny(itemId: string) {
  return vngFetch("/api/probe/mannies", {
    method: "POST",
    body: JSON.stringify({ itemId }),
  });
}

export async function detachContainer(
  mannyId: string,
  containerId: string,
  mode: "drifting" | "hidden_on_asteroid" = "drifting",
  asteroidObjectId?: string
) {
  const body: Record<string, unknown> = { containerId, mode };
  if (mode === "hidden_on_asteroid" && asteroidObjectId) body.objectId = asteroidObjectId;
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/detach-storage-container`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

export async function salvageObject(mannyId: string, objectId: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/salvage`,
    {
      method: "POST",
      body: JSON.stringify({ objectId }),
    }
  );
}

/** Inspect any inspectable sector object (asteroids, detached containers, dormant constructs). Replaces deprecated inspect-asteroid. */
export async function inspectSectorObject(mannyId: string, objectId: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/inspect-sector-object`,
    {
      method: "POST",
      body: JSON.stringify({ objectId }),
    }
  );
}

/** @deprecated Use inspectSectorObject instead */
export async function inspectAsteroid(mannyId: string, objectId: string) {
  return inspectSectorObject(mannyId, objectId);
}

export async function jettisonItem(inventoryId: string, amount?: number) {
  const body: Record<string, unknown> = {};
  if (amount !== undefined) body.amount = amount;
  return vngFetch(
    `/api/probe/inventory/${encodeURIComponent(inventoryId)}/jettison`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

export async function recoverContainer(mannyId: string, objectId: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/recover-storage-container`,
    {
      method: "POST",
      body: JSON.stringify({ objectId }),
    }
  );
}

export async function atomicPrinterCraft(recipe: string) {
  return vngFetch("/api/probe/atomic-printer/craft", {
    method: "POST",
    body: JSON.stringify({ recipe }),
  });
}

export async function getVisitedSectors() {
  return vngFetch("/api/probe/visited-sectors");
}

export async function dropContainerOnAsteroid(
  mannyId: string,
  containerId: string,
  objectId: string
) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/drop-storage-container`,
    {
      method: "POST",
      body: JSON.stringify({ containerId, objectId }),
    }
  );
}

export async function dropContainerOnPlanet(
  mannyId: string,
  containerId: string,
  planetId: string
) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/drop-storage-container`,
    {
      method: "POST",
      body: JSON.stringify({ containerId, planetId }),
    }
  );
}

export async function refillDeuteriumTank(mannyId: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/refill-deuterium-tank`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
}

export async function transferDeuteriumToProbe(
  mannyId: string,
  targetProbeId: number,
  amount: number
) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/transfer-deuterium-to-probe`,
    {
      method: "POST",
      body: JSON.stringify({ targetProbeId, amount }),
    }
  );
}

export async function assembleProbe(mannyId: string, containerIds: string[]) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/assemble-probe`,
    {
      method: "POST",
      body: JSON.stringify({ containerIds }),
    }
  );
}

export async function improveProbe(mannyId: string, improvement: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/improve-probe`,
    {
      method: "POST",
      body: JSON.stringify({ improvement }),
    }
  );
}

export async function installWaypointBookmark(
  mannyId: string,
  objectId: string,
  name: string
) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/install-bookmark`,
    {
      method: "POST",
      body: JSON.stringify({ objectId, name }),
    }
  );
}

export async function getProbeList() {
  return vngFetch("/api/probes");
}

/**
 * Activate an inactive SCUT relay. relayId is the integer from the sector object id
 * (SCUT relay sector objects have purely numeric ids, e.g. "42" → pass 42).
 * Requires a star in the current sector and one integrated_circuit in inventory.
 */
export async function turnOnRelay(
  mannyId: string,
  relayId: number,
  networkName?: string
) {
  const body: Record<string, unknown> = { relayId };
  if (networkName) body.networkName = networkName;
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/turn-on-relay`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

/** Drop a waiting Manny's cargo so it can dock (resource cargo is lost; recoverable items go back to sector). */
export async function dropMannyCargo(mannyId: string) {
  return vngFetch(
    `/api/probe/mannies/${encodeURIComponent(mannyId)}/drop-manny-cargo`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

/** Send a message to another probe (in same sector or same SCUT network) or an inhabited planet (same sector). */
export async function sendMessage(
  recipientType: "probe" | "planet",
  recipientId: number | string,
  body: string
) {
  return vngFetch("/api/probe/messages", {
    method: "POST",
    body: JSON.stringify({ recipient: { type: recipientType, id: recipientId }, body }),
  });
}

/** List available (and installed) probe improvements with ingredient requirements. */
export async function getProbeImprovements() {
  return vngFetch("/api/probe/probe-improvements-available");
}

/** List active player missions. */
export async function getMissions() {
  return vngFetch("/api/probe/missions");
}
