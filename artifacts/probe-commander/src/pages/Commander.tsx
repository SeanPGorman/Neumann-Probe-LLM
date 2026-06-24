import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type SseEvent =
  | { type: "status"; message: string }
  | { type: "message"; content: string }
  | { type: "action"; tool: string; params: Record<string, unknown>; id: string }
  | { type: "result"; tool: string; id: string; success: boolean; data?: unknown; error?: string }
  | { type: "error"; message: string }
  | { type: "done" };

type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; events: SseEvent[] };

type SideTab = "telemetry" | "containers" | "sectors" | "scout";

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    get_game_state: "REFRESH STATE",
    craft_item: "CRAFT ITEM",
    mine_resources: "MINE RESOURCES",
    detach_container: "DETACH CONTAINER",
    repair_manny: "REPAIR MANNY",
    recall_manny: "RECALL MANNY",
    rename_manny: "RENAME MANNY",
    move_probe: "MOVE PROBE",
    scan_sector: "SCAN SECTOR",
    jettison_item: "JETTISON",
    salvage_object: "SALVAGE",
    inspect_asteroid: "INSPECT ASTEROID",
    recover_container: "RECOVER CONTAINER",
    atomic_printer_craft: "ATOMIC PRINT",
  };
  return labels[tool] ?? tool.toUpperCase().replace(/_/g, " ");
}

function objectIcon(type: string): string {
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
  };
  return icons[type] ?? "·";
}

function GaugeBar({ label, value, color }: { label: string; value: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const c = color ?? (pct > 50 ? "hsl(150 80% 45%)" : pct > 25 ? "hsl(45 90% 50%)" : "hsl(0 70% 50%)");
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span style={{ color: c }}>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: c, boxShadow: `0 0 6px ${c}` }} />
      </div>
    </div>
  );
}

function MannyRow({ manny }: { manny: any }) {
  const idle = !manny.currentTask;
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={idle ? "text-primary mt-0.5" : "text-yellow-400 mt-0.5 pulse-active"}>
        {idle ? "●" : "◌"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-foreground font-medium truncate">{manny.name}</div>
        {!idle && (
          <div className="text-muted-foreground text-[10px]">
            {manny.currentTask?.toUpperCase().replace(/_/g, " ")} {manny.taskProgressPercent?.toFixed(0)}%
          </div>
        )}
      </div>
    </div>
  );
}

function TelemetryPanel({ state }: { state: any }) {
  if (!state) {
    return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING TELEMETRY…</div>;
  }
  const { probe, mannies, sectorObjects, inventory } = state;
  const sector = probe.sector ?? { x: 0, y: 0, z: 0 };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tracking-widest">PROBE TELEMETRY</span>
        <span className="text-xs text-primary glow-green">{probe.status?.toUpperCase()}</span>
      </div>
      <div>
        <div className="text-lg font-bold glow-green tracking-wider">{probe.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">SECTOR [{sector.x},{sector.y},{sector.z}]</div>
      </div>
      <div className="space-y-2">
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground">FUEL</span>
            <span className="text-primary">{(probe.fuelDeuterium ?? 0).toFixed(2)} ECE</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full rounded-full"
              style={{ width: `${Math.min(100, (probe.fuelDeuterium ?? 0))}%`, backgroundColor: "hsl(150 80% 45%)", boxShadow: "0 0 6px hsl(150 80% 45%)" }} />
          </div>
        </div>
        <GaugeBar label="HULL" value={probe.integrityPercent} />
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">CARGO</span>
          <span className="text-muted-foreground">{(inventory?.usedCapacity ?? 0).toFixed(2)}/{inventory?.capacity ?? 0} ECE</span>
        </div>
      </div>
      {mannies?.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground tracking-widest mb-2">MANNIES ({mannies.length})</div>
          <div className="space-y-1.5">{mannies.map((m: any) => <MannyRow key={m.id} manny={m} />)}</div>
        </div>
      )}
      {sectorObjects?.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground tracking-widest mb-2">SECTOR ({sectorObjects.length})</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {sectorObjects.map((o: any, i: number) => (
              <div key={i} className="text-xs flex gap-2">
                <span className="text-accent shrink-0">{objectIcon(o.type)}</span>
                <span className="text-muted-foreground truncate">
                  {o.name ?? o.type}
                  {o.resourceTypes?.length ? ` [${o.resourceTypes.join(",")}]` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-[10px] text-muted-foreground hover:text-primary transition-colors px-1"
      title="Copy ID"
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

function ContainersPanel({ refetchSignal }: { refetchSignal: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["log-containers", refetchSignal],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/vng/log/containers`);
      return r.json();
    },
    refetchInterval: 30000,
  });

  const [showOnboard, setShowOnboard] = useState(true);
  const [showFloating, setShowFloating] = useState(true);

  const onboard: any[] = data?.onboard ?? [];
  const floating: any[] = data?.floating ?? [];

  if (isLoading) return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>;
  if (!data) return <div className="text-xs text-muted-foreground italic">No data.</div>;

  const CapacityBar = ({ used, total }: { used: number | null; total: number | null }) => {
    if (used == null || total == null || total === 0) return null;
    const pct = Math.min(100, (used / total) * 100);
    const color = pct >= 95 ? "bg-destructive" : pct >= 70 ? "bg-yellow-500" : "bg-primary";
    return (
      <div className="space-y-0.5">
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
        </div>
        <div className="text-[10px] text-muted-foreground/60 text-right">
          {used.toFixed(2)} / {total.toFixed(0)} ECE
        </div>
      </div>
    );
  };

  const ContentsList = ({ contents }: { contents: { resource: string; amount: number }[] }) => {
    if (!contents || contents.length === 0)
      return <div className="text-[10px] text-muted-foreground/40 italic">empty</div>;
    return (
      <div className="space-y-0.5">
        {contents.map((item) => (
          <div key={item.resource} className="flex items-center justify-between text-[10px]">
            <span className="text-foreground/80">{item.resource.replace(/_/g, " ")}</span>
            <span className="text-primary font-mono">{item.amount.toFixed(2)} ECE</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto">

      {/* On-board containers */}
      <div className="space-y-2">
        <button
          onClick={() => setShowOnboard(v => !v)}
          className="w-full flex items-center justify-between text-xs text-muted-foreground tracking-widest hover:text-foreground transition-colors"
        >
          <span>ON-BOARD ({onboard.length})</span>
          <span>{showOnboard ? "▲" : "▼"}</span>
        </button>
        {showOnboard && (onboard.length === 0
          ? <div className="text-xs text-muted-foreground/40 italic">none</div>
          : <div className="space-y-2">{onboard.map((c: any) => (
            <div key={c.id} className="border border-border rounded p-2.5 text-xs space-y-1.5">
              <div className="font-bold text-foreground">{c.containerName}</div>
              <CapacityBar used={c.usedCapacity} total={c.capacity} />
              <ContentsList contents={c.contents} />
            </div>
          ))}</div>
        )}
      </div>

      {/* Floating containers */}
      <div className="space-y-2">
        <button
          onClick={() => setShowFloating(v => !v)}
          className="w-full flex items-center justify-between text-xs text-muted-foreground tracking-widest hover:text-foreground transition-colors"
        >
          <span>FLOATING ({floating.length})</span>
          <span>{showFloating ? "▲" : "▼"}</span>
        </button>
        {showFloating && (floating.length === 0
          ? <div className="text-xs text-muted-foreground/40 italic">none in current sector</div>
          : <div className="space-y-2">{floating.map((c: any) => (
            <div key={c.id} className="border border-accent/40 rounded p-2.5 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-foreground">{c.containerName}</span>
                <span className="text-[10px] text-muted-foreground/60">
                  [{c.sectorX},{c.sectorY},{c.sectorZ}]
                </span>
              </div>

              {c.anchorObjectId && (
                <div className="text-[10px] text-muted-foreground/60">
                  anchored · {c.anchorObjectName ?? c.anchorObjectId}
                </div>
              )}

              <CapacityBar used={c.usedCapacity} total={c.capacity} />
              <ContentsList contents={c.contents} />

              {c.sectorObjectId && (
                <div className="bg-primary/5 border border-primary/20 rounded px-2 py-1.5 space-y-0.5">
                  <div className="text-[10px] text-primary/70 tracking-wider">SECTOR OBJECT ID</div>
                  <div className="flex items-start gap-1">
                    <span className="text-primary font-mono text-[10px] break-all leading-tight flex-1">
                      {c.sectorObjectId}
                    </span>
                    <CopyButton text={c.sectorObjectId} />
                  </div>
                </div>
              )}

              {c.mannyName && (
                <div className="text-muted-foreground/50 text-[10px]">
                  By {c.mannyName} · {c.detachedAt ? new Date(c.detachedAt).toLocaleString() : ""}
                </div>
              )}
            </div>
          ))}</div>
        )}
      </div>

    </div>
  );
}

function SectorsPanel({ refetchSignal }: { refetchSignal: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["log-sectors", refetchSignal],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/vng/log/sectors`);
      return r.json();
    },
    refetchInterval: 30000,
  });

  const sectors: any[] = data?.sectors ?? [];

  const [expanded, setExpanded] = useState<number | null>(null);

  if (isLoading) return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>;
  if (sectors.length === 0) return (
    <div className="text-xs text-muted-foreground italic">No sectors recorded yet. The current sector is logged automatically.</div>
  );

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground tracking-widest">VISITED SECTORS ({sectors.length})</div>
      <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-y-auto">
        {sectors.map((s: any) => (
          <div key={s.id} className="border border-border rounded text-xs overflow-hidden">
            {/* Header — always visible */}
            <button
              className="w-full text-left p-2.5 space-y-1.5 hover:bg-muted/20 transition-colors"
              onClick={() => setExpanded(expanded === s.id ? null : s.id)}
            >
              <div className="flex items-center justify-between">
                <span className="text-foreground font-bold glow-green">
                  [{s.sectorX},{s.sectorY},{s.sectorZ}]
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-[10px]">{s.visitCount}×</span>
                  <span className="text-muted-foreground text-[10px]">{expanded === s.id ? "▲" : "▼"}</span>
                </div>
              </div>
              {(s.resourceSummary as string[])?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(s.resourceSummary as string[]).map((r: string) => (
                    <span key={r} className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[10px]">{r}</span>
                  ))}
                </div>
              )}
              <div className="text-muted-foreground/60 text-[10px]">
                {(s.objects as any[])?.length ?? 0} objects · {new Date(s.lastVisitedAt).toLocaleString()}
              </div>
            </button>

            {/* Expanded detail */}
            {expanded === s.id && (
              <div className="border-t border-border px-2.5 pb-2.5 pt-2 space-y-2.5">
                <SectorObjectList objects={s.objects ?? []} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const PLANET_CATEGORY_LABEL: Record<string, string> = {
  gas_giant: "Gas Giant",
  ice_giant: "Ice Giant",
  terrestrial: "Terrestrial",
  lava: "Lava",
  frozen: "Frozen",
  dwarf: "Dwarf",
  ocean: "Ocean",
  desert: "Desert",
  jungle: "Jungle",
};

function habitabilityColor(score: number): string {
  if (score >= 0.6) return "text-primary";
  if (score >= 0.3) return "text-yellow-400";
  return "text-muted-foreground";
}

function SectorObjectList({ objects }: { objects: any[] }) {
  const byType: Record<string, any[]> = {};
  for (const o of objects) {
    const key = o.type ?? "unknown";
    if (!byType[key]) byType[key] = [];
    byType[key].push(o);
  }

  const order = ["solar_system", "star", "planet", "asteroid", "dust_cloud", "black_hole", "detached_container", "drifting_item", "manny"];
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
              <SectorObject key={i} o={o} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SectorObject({ o }: { o: any }) {
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
          <div className="pl-2 space-y-0.5">
            {asteroids.map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px]">
                <span className="text-primary/50">◆</span>
                <span className="text-primary/80">{a.name ?? "Asteroid"}</span>
                {a.composition && <span className="text-muted-foreground">{a.composition.replace(/_/g, " ")}</span>}
                <span className="text-muted-foreground/40 font-mono text-[9px]">{a.id?.slice(0, 8)}</span>
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

function EventRow({ event }: { event: SseEvent }) {
  if (event.type === "status") return (
    <div className="text-xs text-muted-foreground italic">▸ {event.message}</div>
  );
  if (event.type === "message") return (
    <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{event.content}</div>
  );
  if (event.type === "action") {
    const paramStr = Object.entries(event.params)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    return (
      <div className="py-1 border-l-2 border-accent pl-3 space-y-0.5">
        <div className="text-xs text-accent font-bold tracking-wider">⟶ {toolLabel(event.tool)}</div>
        {paramStr && <div className="text-xs text-muted-foreground font-mono break-all">{paramStr}</div>}
      </div>
    );
  }
  if (event.type === "result") {
    if (!event.success) return (
      <div className="text-xs text-destructive pl-3 border-l-2 border-destructive">✕ {event.error}</div>
    );
    return (
      <div className="text-xs text-primary pl-3 border-l-2 border-primary">✓ {toolLabel(event.tool)} OK</div>
    );
  }
  if (event.type === "error") return (
    <div className="text-xs text-destructive glow-red">⚠ {event.message}</div>
  );
  return null;
}

function AssistantBubble({ events }: { events: SseEvent[] }) {
  const visible = events.filter(e =>
    e.type === "message" || e.type === "action" || e.type === "result" ||
    e.type === "status" || e.type === "error"
  );
  if (visible.length === 0) return null;
  return (
    <div className="space-y-1.5 border border-border rounded p-3 bg-card/60 border-glow">
      {visible.map((e, i) => <EventRow key={i} event={e} />)}
    </div>
  );
}

function ScoutPanel() {
  const [coords, setCoords] = useState({ x: "", y: "", z: "" });
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const scout = async () => {
    const x = parseInt(coords.x, 10);
    const y = parseInt(coords.y, 10);
    const z = parseInt(coords.z, 10);
    if ([x, y, z].some(isNaN)) { setError("Enter valid integers for x, y, z"); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await fetch(`${BASE}/api/vng/log/scout?x=${x}&y=${y}&z=${z}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const coord = (k: "x" | "y" | "z") => (
    <input
      type="number"
      placeholder={k}
      value={coords[k]}
      onChange={e => setCoords(p => ({ ...p, [k]: e.target.value }))}
      className="w-16 bg-background border border-border rounded px-2 py-1 text-xs text-center font-mono text-foreground focus:outline-none focus:border-primary"
    />
  );

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground tracking-widest">SECTOR SCOUT</div>
      <div className="text-[10px] text-muted-foreground/60">
        Query any sector's contents before travelling. Coordinates must sum to an even number.
      </div>

      <div className="flex items-center gap-1.5">
        {coord("x")} {coord("y")} {coord("z")}
        <button
          onClick={scout}
          disabled={loading}
          className="ml-1 px-3 py-1 text-xs border border-primary text-primary rounded hover:bg-primary/10 disabled:opacity-40 transition-colors tracking-widest"
        >
          {loading ? "…" : "SCAN"}
        </button>
      </div>

      {error && <div className="text-xs text-destructive">{error}</div>}

      {result && (
        <div className="space-y-2">
          <div className="text-xs text-foreground font-bold glow-green">
            [{result.x},{result.y},{result.z}]
          </div>
          {result.resourceSummary?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.resourceSummary.map((r: string) => (
                <span key={r} className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[10px]">{r}</span>
              ))}
            </div>
          )}
          {result.objects?.length === 0
            ? <div className="text-xs text-muted-foreground/40 italic">Empty sector — no objects detected.</div>
            : <SectorObjectList objects={result.objects} />
          }
        </div>
      )}
    </div>
  );
}

export default function Commander() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([{
    role: "assistant",
    events: [{
      type: "message",
      content: "PROBE COMMANDER ONLINE.\n\nGive me a natural language command and I'll execute the necessary operations.\n\nExamples:\n• \"Have a Manny craft an additional container, then detach it and mine metals into it\"\n• \"Tell me what resources the sector has\"\n• \"Recall manny-3 and repair them to full integrity\"",
    }],
  }]);
  const [isRunning, setIsRunning] = useState(false);
  const [liveEvents, setLiveEvents] = useState<SseEvent[]>([]);
  const [sideTab, setSideTab] = useState<SideTab>("telemetry");
  const [logRefetch, setLogRefetch] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: state } = useQuery({
    queryKey: ["probe-state"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/vng/state`);
      if (!r.ok) throw new Error(`State fetch failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 30000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveEvents]);

  const sendCommand = useCallback(async () => {
    const cmd = input.trim();
    if (!cmd || isRunning) return;
    setInput("");
    setIsRunning(true);
    setLiveEvents([]);
    setMessages(prev => [...prev, { role: "user", content: cmd }]);

    const events: SseEvent[] = [];
    try {
      const res = await fetch(`${BASE}/api/vng/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event: SseEvent = JSON.parse(line.slice(6));
              if (event.type !== "done") {
                events.push(event);
                setLiveEvents([...events]);
              }
            } catch {}
          }
        }
      }
    } catch (err: any) {
      events.push({ type: "error", message: err.message });
    }

    setMessages(prev => [...prev, { role: "assistant", events }]);
    setLiveEvents([]);
    setIsRunning(false);
    setLogRefetch(n => n + 1);
  }, [input, isRunning]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCommand(); }
  };

  const TABS: { id: SideTab; label: string }[] = [
    { id: "telemetry", label: "PROBE" },
    { id: "containers", label: "CNTRS" },
    { id: "sectors", label: "MAP" },
    { id: "scout", label: "SCOUT" },
  ];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row gap-4 p-4 max-w-7xl mx-auto">
      {/* Sidebar */}
      <div className="lg:w-72 shrink-0 flex flex-col gap-2">
        <div className="text-xs text-muted-foreground tracking-[0.3em] glow-green">
          VON NEUMANN PROBE
        </div>
        {/* Tab bar */}
        <div className="flex border border-border rounded overflow-hidden">
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setSideTab(tab.id)}
              className={`flex-1 py-1.5 text-xs tracking-widest transition-all ${
                sideTab === tab.id
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        <div className="border border-border border-glow rounded p-4 flex-1 scanlines">
          {sideTab === "telemetry" && <TelemetryPanel state={state} />}
          {sideTab === "containers" && <ContainersPanel refetchSignal={logRefetch} />}
          {sideTab === "sectors" && <SectorsPanel refetchSignal={logRefetch} />}
          {sideTab === "scout" && <ScoutPanel />}
        </div>

        <div className="text-xs text-muted-foreground text-center tracking-widest opacity-40">
          AUTO-REFRESH 30s
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="text-xs text-muted-foreground tracking-[0.3em] mb-3 glow-cyan">
          OPERATOR TERMINAL
        </div>

        <div className="flex-1 border border-border border-glow rounded overflow-y-auto p-4 space-y-4 min-h-[400px] max-h-[calc(100vh-220px)] bg-card/30 scanlines">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div className="flex gap-2 items-start">
                  <span className="text-accent text-xs shrink-0 mt-0.5 glow-cyan">OPERATOR›</span>
                  <span className="text-foreground text-sm">{msg.content}</span>
                </div>
              ) : (
                <div className="flex gap-2 items-start">
                  <span className="text-primary text-xs shrink-0 mt-0.5 glow-green">PROBE›</span>
                  <div className="flex-1"><AssistantBubble events={msg.events} /></div>
                </div>
              )}
            </div>
          ))}

          {isRunning && (
            <div className="flex gap-2 items-start">
              <span className="text-primary text-xs shrink-0 mt-0.5 glow-green pulse-active">PROBE›</span>
              <div className="flex-1">
                {liveEvents.length > 0 ? (
                  <div className="space-y-1.5 border border-border rounded p-3 bg-card/60 border-glow">
                    {liveEvents.filter(e =>
                      e.type === "message" || e.type === "action" || e.type === "result" ||
                      e.type === "status" || e.type === "error"
                    ).map((e, i) => <EventRow key={i} event={e} />)}
                    <div className="text-xs text-primary cursor-blink" />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground pulse-active">PROCESSING…</span>
                )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="mt-3 border border-border border-glow rounded p-3 bg-card/30">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <div className="text-xs text-muted-foreground mb-1.5 tracking-widest">
                COMMAND INPUT {isRunning && <span className="text-yellow-400 pulse-active">● EXECUTING</span>}
              </div>
              <textarea
                value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                disabled={isRunning} rows={2}
                placeholder="Tell your probe what to do… (Enter to send, Shift+Enter for newline)"
                className="w-full bg-transparent text-foreground text-sm placeholder:text-muted-foreground/40 resize-none outline-none font-mono"
              />
            </div>
            <button onClick={sendCommand} disabled={isRunning || !input.trim()}
              className="shrink-0 px-4 py-2 text-xs tracking-widest font-bold border rounded transition-all border-primary text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-30 disabled:cursor-not-allowed">
              {isRunning ? "…" : "EXECUTE"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
