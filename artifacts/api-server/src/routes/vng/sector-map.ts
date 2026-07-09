// Shared enrichment for raw VNG SectorObject[] → a UI-friendly shape consumed
// by both /scout (log.ts) and /state (index.ts). The game API exposes object
// membership + metadata but NO positional data, so this is metadata only; the
// frontend synthesizes any spatial layout from it.

/**
 * Merge a solar_system's `bookmarkTargets` (bodies eligible for a waypoint
 * bookmark — carry mass/radius/category/habitability) with its `minableTargets`
 * (mineable bodies — carry resources/amounts). The same body can appear in both
 * with complementary fields, so we merge by id rather than concatenate, which
 * would otherwise duplicate asteroids and lose half their detail.
 */
function mergeBodies(bookmarkTargets: any[], minableTargets: any[]): any[] {
  const byKey = new Map<string, any>();
  const upsert = (b: any) => {
    if (!b) return;
    const key = b.id ?? `${b.type}:${b.name ?? ""}:${b.mass ?? ""}`;
    const prev = byKey.get(key) ?? {};
    byKey.set(key, {
      id: b.id ?? prev.id ?? null,
      type: b.type ?? prev.type ?? null,
      name: b.name ?? prev.name ?? null,
      category: b.category ?? prev.category ?? null,
      mass: b.mass ?? prev.mass ?? null,
      massUnit: b.massUnit ?? prev.massUnit ?? null,
      radius: b.radius ?? prev.radius ?? null,
      radiusUnit: b.radiusUnit ?? prev.radiusUnit ?? null,
      habitabilityScore: b.habitabilityScore ?? prev.habitabilityScore ?? null,
      intelligentLife: b.intelligentLife ?? prev.intelligentLife ?? null,
      resources: b.resources ?? prev.resources ?? null,
      resourceTypes: b.resourceTypes ?? prev.resourceTypes ?? null,
      resourceAmounts: b.resourceAmounts ?? prev.resourceAmounts ?? null,
    });
  };
  for (const b of bookmarkTargets ?? []) upsert(b);
  for (const b of minableTargets ?? []) upsert(b);
  return Array.from(byKey.values());
}

/**
 * Enrich raw SectorObject[] into the shape the UI consumes. Output is a strict
 * superset of the old flattened `/state` shape ({id,type,name,summary,
 * resourceTypes}), so existing consumers keep working.
 */
export function mapSectorObjects(rawObjects: any[]): any[] {
  return (rawObjects ?? []).map((o: any) => {
    const base: Record<string, unknown> = {
      id: o.id ?? null,
      type: o.type,
      name: o.name ?? null,
      summary: o.summary ?? null,
      dangerLevel: o.dangerLevel ?? null,
      resourceTypes: o.resourceTypes ?? [],
    };

    switch (o.type) {
      case "solar_system":
        base.starCount = o.starCount ?? 0;
        base.planetCount = o.planetCount ?? 0;
        base.orbitalBodyCount = o.orbitalBodyCount ?? 0;
        base.mass = o.mass ?? null;
        base.massUnit = o.massUnit ?? null;
        base.radius = o.radius ?? null;
        base.radiusUnit = o.radiusUnit ?? null;
        base.bodies = mergeBodies(o.bookmarkTargets, o.minableTargets);
        // Player-placed beacons on this system (carry playerId/playerName).
        base.waypointBookmarks = (o.waypointBookmarks ?? []).map((w: any) => ({
          name: w.name ?? null,
          playerId: w.playerId ?? null,
          playerName: w.playerName ?? null,
          createdAt: w.createdAt ?? null,
        }));
        break;

      case "planet":
        base.category = o.category ?? null;
        base.habitabilityScore = o.habitabilityScore ?? null;
        base.intelligentLife = o.intelligentLife ?? null;
        base.mass = o.mass ?? null;
        base.massUnit = o.massUnit ?? null;
        base.radius = o.radius ?? null;
        base.radiusUnit = o.radiusUnit ?? null;
        break;

      case "asteroid":
        base.composition = o.composition ?? null;
        base.sizeCategory = o.sizeCategory ?? null;
        base.resources = o.resources ?? null;
        base.resourceAmounts = o.resourceAmounts ?? null;
        base.mannyMineable = o.mannyMineable ?? null;
        base.mass = o.mass ?? null;
        base.massUnit = o.massUnit ?? null;
        break;

      case "detached_container":
        // User-dropped storage. The API records no creator id, so the best we
        // can say is "player-created" generically.
        base.capacity = o.capacity ?? null;
        base.capacityUnit = o.capacityUnit ?? null;
        base.mode = o.mode ?? null;
        base.targetObjectId = o.targetObjectId ?? null;
        base.salvageable = o.salvageable ?? false;
        base.userCreated = true;
        break;

      case "scut_relay":
        // Player-built relay. createdByProbeId lets the UI resolve ownership
        // against the current probe (mine vs another player's).
        base.status = o.status ?? null;
        base.createdByProbeId = o.createdByProbeId ?? null;
        base.createdByProbeName = o.createdByProbeName ?? null;
        base.coverageRadiusSectors = o.coverageRadiusSectors ?? null;
        base.network = o.network ?? null;
        base.activatedAt = o.activatedAt ?? null;
        break;

      case "deuterium_refuel_station":
        base.planetId = o.planetId ?? null;
        base.planetName = o.planetName ?? null;
        break;

      case "dormant_construct":
        base.apparentOrigin = o.apparentOrigin ?? null;
        base.activityStatus = o.activityStatus ?? null;
        base.knownFunction = o.knownFunction ?? null;
        break;

      case "drifting_item":
        base.itemType = o.itemType ?? null;
        base.quantity = o.quantity ?? null;
        base.containerSpace = o.containerSpace ?? null;
        break;

      // star, dust_cloud, black_hole, manny, etc.: base fields (incl. summary)
      // carry enough for the map; nothing type-specific needed today.
    }

    return base;
  });
}

/** Distinct resource types present across all objects in a sector. */
export function sectorResourceSummary(rawObjects: any[]): string[] {
  return Array.from(
    new Set((rawObjects ?? []).flatMap((o: any) => o.resourceTypes ?? []))
  );
}
