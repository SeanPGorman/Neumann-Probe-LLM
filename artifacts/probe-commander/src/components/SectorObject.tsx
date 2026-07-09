// Shared renderers for VNG sector objects, lifted out of Commander.tsx so both
// the telemetry/sectors panels and the SYSTEM map can render object detail
// consistently. Pure presentational — no data fetching, no app-local state.

export function objectIcon(type: string): string {
  const icons: Record<string, string> = {
    asteroid: "⬡",
    planet: "○",
    star: "★",
    black_hole: "◉",
    solar_system: "◎",
    dust_cloud: "~",
    manny: "♦",
    drifting_item: "◇",
    detached_container: "□",
    scut_relay: "⚙",
    deuterium_refuel_station: "⛽",
    dormant_construct: "⍟",
    waypoint_bookmark: "⚑",
    self_probe: "⬦",
  };
  return icons[type] ?? "·";
}

export const PLANET_CATEGORY_LABEL: Record<string, string> = {
  gas_giant: "Gas Giant",
  ice_giant: "Ice Giant",
  terrestrial: "Terrestrial",
  rocky: "Rocky",
  lava: "Lava",
  frozen: "Frozen",
  dwarf: "Dwarf",
  ocean: "Ocean",
  desert: "Desert",
  jungle: "Jungle",
};

export function habitabilityColor(score: number): string {
  if (score >= 0.6) return "text-primary";
  if (score >= 0.3) return "text-yellow-400";
  return "text-muted-foreground";
}

export function SectorObjectList({ objects }: { objects: any[] }) {
  const byType: Record<string, any[]> = {};
  for (const o of objects) {
    const key = o.type ?? "unknown";
    if (!byType[key]) byType[key] = [];
    byType[key].push(o);
  }

  const order = ["solar_system", "star", "planet", "asteroid", "dust_cloud", "black_hole", "detached_container", "scut_relay", "deuterium_refuel_station", "dormant_construct", "drifting_item", "manny"];
  const types = [...new Set([...order.filter(t => byType[t]), ...Object.keys(byType).filter(t => !order.includes(t))])];

  return (
    <div className="space-y-2">
      {types.map(type => (
        <div key={type}>
          <div className="text-[10px] text-muted-foreground tracking-wider uppercase mb-1 flex items-center gap-1">
            <span>{objectIcon(type)}</span>
            <span>{type.replace(/_/g, " ")} ({byType[type].length})</span>
          </div>
          <div className="space-y-1 pl-2">
            {byType[type].map((o: any, i: number) => (
              <SectorObject key={`${o.type}:${o.id ?? i}`} o={o} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SectorObject({ o }: { o: any }) {
  if (o.type === "solar_system") {
    const planets = (o.bodies ?? []).filter((b: any) => b.type === "planet");
    const stars = (o.bodies ?? []).filter((b: any) => b.type === "star");
    const asteroids = (o.bodies ?? []).filter((b: any) => b.type === "asteroid");
    return (
      <div className="space-y-1">
        <div className="text-foreground font-medium">{o.name ?? "Unnamed system"}</div>
        <div className="text-muted-foreground text-[10px]">
          {stars.length} star{stars.length !== 1 ? "s" : ""} · {planets.length} planet{planets.length !== 1 ? "s" : ""}
          {asteroids.length > 0 && ` · ${asteroids.length} asteroid${asteroids.length !== 1 ? "s" : ""}`}
          {` · danger: ${o.dangerLevel ?? "?"}`}
        </div>
        {planets.length > 0 && (
          <div className="pl-2 space-y-0.5">
            {planets.map((p: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground/50">○</span>
                <span className="text-muted-foreground">{PLANET_CATEGORY_LABEL[p.category] ?? p.category ?? "Planet"}</span>
                {p.habitabilityScore != null && (
                  <span className={habitabilityColor(p.habitabilityScore)}>
                    hab {(p.habitabilityScore * 100).toFixed(0)}%
                  </span>
                )}
                {p.intelligentLife && <span className="text-yellow-400 font-bold">★ LIFE</span>}
                <span className="text-muted-foreground/40">{p.mass?.toFixed(2)}{p.massUnit}</span>
              </div>
            ))}
          </div>
        )}
        {asteroids.length > 0 && (
          <div className="pl-2 space-y-1">
            {asteroids.map((a: any, i: number) => (
              <div key={i} className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-primary/50">◆</span>
                  <span className="text-primary/80">{a.name ?? a.composition?.replace(/_/g, " ") ?? "Asteroid"}</span>
                  {a.sizeCategory && <span className="text-muted-foreground/50">{a.sizeCategory}</span>}
                  <span className="text-muted-foreground/40 font-mono text-[9px]">{a.id?.slice(0, 8)}</span>
                </div>
                {a.composition && !a.sizeCategory && (
                  <div className="pl-3 text-[9px] text-muted-foreground/50">{a.composition.replace(/_/g, " ")}</div>
                )}
                {a.mass != null && (
                  <div className="pl-3 text-[9px] text-muted-foreground/50">
                    {a.mass.toFixed(4)} {a.massUnit} · r {a.radius?.toFixed(4)} {a.radiusUnit}
                    {!a.composition && <span className="ml-2 text-muted-foreground/30 italic">inspect to reveal resources</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (o.type === "asteroid") {
    const amounts = o.resourceAmounts ?? {};
    const nonZero = Object.entries(amounts).filter(([, v]) => (v as number) > 0);
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground">{o.name ?? o.composition ?? "Asteroid"}</span>
          {o.sizeCategory && <span className="text-muted-foreground/60 text-[10px]">{o.sizeCategory}</span>}
        </div>
        {o.composition && <div className="text-muted-foreground text-[10px]">{o.composition.replace(/_/g, " ")}</div>}
        {nonZero.length > 0 && (
          <div className="flex flex-wrap gap-x-3 text-[10px]">
            {nonZero.map(([res, amt]) => (
              <span key={res} className="text-primary/80">{res}: {(amt as number).toFixed(0)}</span>
            ))}
          </div>
        )}
        {o.id && <div className="text-muted-foreground/40 text-[10px] font-mono">id={o.id}</div>}
      </div>
    );
  }

  if (o.type === "detached_container") {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-accent">{o.name ?? "Container"}</span>
          {o.capacity && <span className="text-muted-foreground text-[10px]">{o.capacity} ECE</span>}
          {o.salvageable && <span className="text-yellow-400 text-[10px]">salvageable</span>}
        </div>
        {o.id && (
          <div className="text-primary/60 text-[10px] font-mono break-all">
            {o.id}
          </div>
        )}
      </div>
    );
  }

  if (o.type === "scut_relay") {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-accent">{o.name ?? "SCUT relay"}</span>
          {o.status && <span className="text-muted-foreground text-[10px]">{o.status}</span>}
          {o.coverageRadiusSectors != null && (
            <span className="text-muted-foreground/60 text-[10px]">r {o.coverageRadiusSectors} sec</span>
          )}
        </div>
        {o.network?.name && <div className="text-muted-foreground/60 text-[10px]">network: {o.network.name}</div>}
        {o.createdByProbeName && (
          <div className="text-muted-foreground/40 text-[10px]">by {o.createdByProbeName}</div>
        )}
      </div>
    );
  }

  if (o.type === "planet") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{PLANET_CATEGORY_LABEL[o.category] ?? o.category ?? "Planet"}</span>
        {o.habitabilityScore != null && (
          <span className={`text-[10px] ${habitabilityColor(o.habitabilityScore)}`}>
            hab {(o.habitabilityScore * 100).toFixed(0)}%
          </span>
        )}
        {o.intelligentLife && <span className="text-yellow-400 text-[10px] font-bold">★ LIFE</span>}
        {o.mass != null && <span className="text-muted-foreground/40 text-[10px]">{o.mass.toFixed(2)} {o.massUnit}</span>}
      </div>
    );
  }

  // Fallback for any other type
  return (
    <div className="text-muted-foreground">
      {o.name ?? o.summary ?? o.type}
      {o.id && <span className="text-[10px] text-muted-foreground/40 ml-1 font-mono">({o.id.slice(0, 8)}…)</span>}
    </div>
  );
}
