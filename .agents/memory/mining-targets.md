---
name: Mining targets inside solar_system bodies
description: Mineable bodies in the VNG game are NOT standalone sector objects of type "asteroid" — they live inside solar_system.bodies after mapSectorObjects() merges bookmarkTargets+minableTargets.
---

## The Rule

Never filter `sectorObjects` for `type === "asteroid"` to find mining targets. The actual mineable bodies are nested inside `solar_system` objects, accessed via the `bodies[]` array after `mapSectorObjects()` processes the raw VNG API response.

## Why

The VNG sector API returns a `solar_system` wrapper object whose raw form has `bookmarkTargets[]` and `minableTargets[]`. `mapSectorObjects()` in `sector-map.ts` calls `mergeBodies()` to combine them into `solar_system.bodies[]`. Each body has `{ id, type, name, category, resourceTypes, resources }`. Only bodies with non-empty `resourceTypes` are currently mineable (e.g. asteroid bodies with `resourceTypes: ["metals"]`).

Standalone `asteroid`-type sector objects can also appear (same filter applies — check `resourceTypes`), but in practice the primary mining targets are solar system bodies.

## How to Apply

When collecting mineable targets from a raw or mapped sector response:

```typescript
const mappedSector = mapSectorObjects(rawSectorObjects);
const targets: any[] = [];
for (const obj of mappedSector) {
  if (obj.type === "solar_system") {
    for (const body of (obj.bodies ?? [])) {
      if ((body.resourceTypes ?? []).length > 0) targets.push(body);
    }
  } else if (obj.type === "asteroid" && (obj.resourceTypes ?? []).length > 0) {
    targets.push(obj);
  }
}
```

The body `id` is what gets passed to `detachContainer(mannyId, containerId, "hidden_on_asteroid", body.id)` and `mineResources(mannyId, body.id, resourceTypes, amount, containerObjectId)`.

## Category → Resource mapping

From the system prompt in index.ts:
- `"frozen"` / `"ocean"` → ice and organics
- `"rocky"` / `"dwarf"` → metals
- any category → deuterium

Planet bodies without `resourceTypes` need a scan first to reveal mineable resources.
