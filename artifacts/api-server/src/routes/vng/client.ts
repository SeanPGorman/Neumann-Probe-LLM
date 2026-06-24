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
    headers: { ...headers(), ...(init.headers as Record<string, string> ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = (body as any)?.error?.message ?? (body as any)?.message ?? res.statusText;
    throw new Error(`VNG API error (${res.status}): ${msg}`);
  }
  return body;
}

export async function getProbe() {
  return vngFetch("/api/probe");
}

export async function getMannies() {
  return vngFetch("/api/probe/mannies");
}

export async function getSector() {
  return vngFetch("/api/probe/sector");
}

export async function getInventory() {
  return vngFetch("/api/probe/inventory");
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
    body: JSON.stringify({ destination: { x, y, z } }),
  });
}

export async function craftItem(mannyId: number, recipe: string) {
  return vngFetch(`/api/probe/mannies/${mannyId}/craft`, {
    method: "POST",
    body: JSON.stringify({ recipe }),
  });
}

export async function mineResources(
  mannyId: number,
  objectId: string,
  resources: string[],
  targetAmount: number,
  targetContainerId?: string
) {
  const body: Record<string, unknown> = { objectId, resources, targetAmount };
  if (targetContainerId) body.targetContainerId = targetContainerId;
  return vngFetch(`/api/probe/mannies/${mannyId}/mine`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function repairManny(mannyId: number, integrityPercent: number) {
  return vngFetch(`/api/probe/mannies/${mannyId}/repair`, {
    method: "POST",
    body: JSON.stringify({ integrityPercent }),
  });
}

export async function recallManny(mannyId: number) {
  return vngFetch(`/api/probe/mannies/${mannyId}/recall`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function renameManny(mannyId: number, name: string) {
  return vngFetch(`/api/probe/mannies/${mannyId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function detachContainer(mannyId: number, containerId: string) {
  return vngFetch(`/api/probe/mannies/${mannyId}/detach-storage-container`, {
    method: "POST",
    body: JSON.stringify({ containerId }),
  });
}

export async function salvageObject(mannyId: number, objectId: string) {
  return vngFetch(`/api/probe/mannies/${mannyId}/salvage`, {
    method: "POST",
    body: JSON.stringify({ objectId }),
  });
}

export async function inspectAsteroid(mannyId: number, objectId: string) {
  return vngFetch(`/api/probe/mannies/${mannyId}/inspect-asteroid`, {
    method: "POST",
    body: JSON.stringify({ objectId }),
  });
}

export async function jettisonItem(inventoryId: string, amount?: number) {
  const body: Record<string, unknown> = {};
  if (amount !== undefined) body.amount = amount;
  return vngFetch(`/api/probe/inventory/${encodeURIComponent(inventoryId)}/jettison`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function recoverContainer(mannyId: number, objectId: string) {
  return vngFetch(`/api/probe/mannies/${mannyId}/recover-storage-container`, {
    method: "POST",
    body: JSON.stringify({ objectId }),
  });
}

export async function atomicPrinterCraft(recipe: string) {
  return vngFetch("/api/probe/atomic-printer/craft", {
    method: "POST",
    body: JSON.stringify({ recipe }),
  });
}
