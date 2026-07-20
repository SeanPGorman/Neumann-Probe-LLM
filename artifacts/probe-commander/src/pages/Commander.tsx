import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2 } from "lucide-react";
import { GlobeMap } from "./GlobeMap";
import { SystemMap } from "./SystemMap";
import { objectIcon, SectorObjectList } from "../components/SectorObject";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useIsDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  return json as T;
}

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

type SideTab = "telemetry" | "containers" | "sectors" | "scout" | "globe" | "system" | "scheduled";

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    get_game_state: "REFRESH STATE",
    craft_item: "CRAFT ITEM",
    mine_resources: "MINE RESOURCES",
    detach_container: "DETACH CONTAINER",
    repair_manny: "REPAIR MANNY",
    recall_manny: "RECALL MANNY",
    rename_manny: "RENAME MANNY",
    deploy_manny: "DEPLOY MANNY",
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

function ApiError({ error }: { error: Error }) {
  return (
    <div className="border border-destructive/50 rounded p-3 space-y-1 bg-destructive/5">
      <div className="text-xs text-destructive tracking-widest font-bold">API ERROR</div>
      <div className="text-xs text-destructive/80 break-words font-mono">{error.message}</div>
      <div className="text-[10px] text-muted-foreground pt-1">
        Check that <span className="text-foreground font-mono">VNG_API_KEY</span> is set correctly in your <span className="text-foreground font-mono">api-server/.env</span> file.
      </div>
    </div>
  );
}

function ScanReadinessBar({ scan }: { scan: { currentSectorResidenceSeconds: number; requiredResidenceSeconds: number; scanQuality: number } | null }) {
  if (!scan) return null;
  const { currentSectorResidenceSeconds: current, requiredResidenceSeconds: required, scanQuality } = scan;
  const pct = required > 0 ? Math.min(100, (current / required) * 100) : 100;
  const ready = scanQuality >= 1;
  const remainingSec = Math.max(0, required - current);
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const label = ready ? "READY" : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const color = ready ? "hsl(150 80% 45%)" : "hsl(38 95% 55%)";
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">SCAN</span>
        <span style={{ color }}>{label}</span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-1000"
          style={{ width: `${pct}%`, backgroundColor: color, boxShadow: ready ? `0 0 6px ${color}` : "none" }} />
      </div>
    </div>
  );
}

type ProbeEntry = { id: number; name: string; status: string; isDefault?: boolean };

function TelemetryPanel({
  state, error, probeList = [], selectedProbeId = null, onSelectProbe = () => {},
}: {
  state: any; error: Error | null;
  probeList?: ProbeEntry[];
  selectedProbeId?: number | null;
  onSelectProbe?: (id: number | null) => void;
}) {
  if (error) return <ApiError error={error} />;
  if (!state) {
    return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING TELEMETRY…</div>;
  }
  const { probe, mannies, stowedMannies, sectorObjects, inventory, scan } = state;
  const sector = probe.sector ?? probe.movement?.target ?? probe.movement?.origin ?? { x: 0, y: 0, z: 0 };
  const defaultId = probeList.find(p => p.isDefault)?.id ?? probeList[0]?.id ?? null;
  const currentId = selectedProbeId ?? defaultId;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tracking-widest">PROBE TELEMETRY</span>
        <span className="text-xs text-primary glow-green">{probe.status?.toUpperCase()}</span>
      </div>
      <div>
        {probeList.length > 1 ? (
          <div className="relative flex items-center gap-1">
            <select
              value={currentId ?? ""}
              onChange={e => {
                const id = Number(e.target.value);
                onSelectProbe(id === defaultId ? null : id);
              }}
              className="text-lg font-bold tracking-wider bg-transparent border-none outline-none cursor-pointer text-primary glow-green flex-1 pr-4"
              style={{ WebkitAppearance: "none", appearance: "none" }}
              title="Switch probe"
            >
              {probeList.map(p => (
                <option key={p.id} value={p.id} style={{ background: "hsl(222 20% 8%)", color: "hsl(150 80% 55%)" }}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-primary text-xs pointer-events-none shrink-0 -ml-4">▾</span>
          </div>
        ) : (
          <div className="text-lg font-bold glow-green tracking-wider">{probe.name}</div>
        )}
        <div className="text-xs text-muted-foreground mt-0.5">
          {probe.status === "accelerating" || probe.status === "cruising" || probe.status === "decelerating"
            ? `→ [${sector.x},${sector.y},${sector.z}]`
            : `SECTOR [${sector.x},${sector.y},${sector.z}]`}
        </div>
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
        <ScanReadinessBar scan={scan} />
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">CARGO</span>
          <span className="text-muted-foreground">{(inventory?.usedCapacity ?? 0).toFixed(2)}/{inventory?.capacity ?? 0} ECE</span>
        </div>
      </div>
      {(mannies?.length > 0 || stowedMannies?.length > 0) && (
        <div>
          <div className="text-xs text-muted-foreground tracking-widest mb-2">
            MANNIES ({mannies?.length ?? 0} active{stowedMannies?.length > 0 ? `, ${stowedMannies.length} stowed` : ""})
          </div>
          <div className="space-y-1.5">
            {mannies?.map((m: any) => <MannyRow key={m.id} manny={m} />)}
            {stowedMannies?.map((m: any) => (
              <div key={m.itemId} className="flex items-start gap-2 text-xs opacity-50">
                <span className="text-muted-foreground mt-0.5">◇</span>
                <div className="flex-1 min-w-0">
                  <div className="text-foreground font-medium truncate">{m.name}</div>
                  <div className="text-muted-foreground text-[10px]">STOWED — say "deploy {m.name}" to activate</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {sectorObjects?.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground tracking-widest mb-2">SECTOR ({sectorObjects.length})</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {sectorObjects.map((o: any, i: number) => (
              <div key={i} className="text-xs flex gap-2">
                <span className="text-accent shrink-0">{objectIcon(o.type)}</span>
                <span className={`text-muted-foreground ${o.type === "waypoint_bookmark" ? "break-words" : "truncate"}`}>
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

function ContainersPanel({ refetchSignal, probeId }: { refetchSignal: number; probeId?: number | null }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["log-containers", refetchSignal, probeId],
    queryFn: () => fetchJson(`${BASE}/api/vng/log/containers${probeId ? `?probeId=${probeId}` : ""}`),
    refetchInterval: 30000,
  });

  const [showOnboard, setShowOnboard] = useState(true);
  const [showFloating, setShowFloating] = useState(true);

  const probeStorage = data?.probeStorage ?? null;
  const onboard: any[] = data?.onboard ?? [];
  const floating: any[] = data?.floating ?? [];

  if (isLoading) return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>;
  if (error) return <ApiError error={error as Error} />;

  const CapacityBar = ({ used, total }: { used: number | null; total: number | null }) => {
    if (used == null || total == null || total === 0) return null;
    const pct = Math.min(100, (used / total) * 100);
    const color = pct >= 70 ? "bg-primary" : pct >= 30 ? "bg-yellow-500" : "bg-destructive";
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
    <div className="space-y-4">

      {/* Probe hull storage */}
      {probeStorage && (
        <div className="border border-primary/40 rounded p-2.5 text-xs space-y-1.5">
          <div className="font-bold text-primary tracking-wider">PROBE STORAGE</div>
          <CapacityBar used={probeStorage.usedCapacity} total={probeStorage.capacity} />
          <ContentsList contents={probeStorage.contents} />
          {probeStorage.items?.length > 0 && (
            <div className="space-y-0.5">
              {probeStorage.items.map((item: any, i: number) => (
                <div key={i} className="text-[10px] text-foreground/80">
                  {item.name.replace(/_/g, " ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
  const { data, isLoading, error } = useQuery({
    queryKey: ["log-sectors", refetchSignal],
    queryFn: () => fetchJson(`${BASE}/api/vng/log/sectors`),
    refetchInterval: 30000,
  });

  const sectors: any[] = data?.sectors ?? [];

  const [expanded, setExpanded] = useState<number | null>(null);

  if (isLoading) return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>;
  if (error) return <ApiError error={error as Error} />;
  if (sectors.length === 0) return (
    <div className="text-xs text-muted-foreground italic">No sectors recorded yet. The current sector is logged automatically.</div>
  );

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground tracking-widest">VISITED SECTORS ({sectors.length})</div>
      <div className="space-y-2">
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

function ScoutPanel({ initialTarget }: { initialTarget?: { x: number; y: number; z: number } | null }) {
  const [coords, setCoords] = useState({ x: "", y: "", z: "" });
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const doScout = useCallback(async (x: number, y: number, z: number) => {
    setLoading(true); setError(null); setResult(null);
    try {
      const data = await fetchJson(`${BASE}/api/vng/log/scout?x=${x}&y=${y}&z=${z}`);
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialTarget) return;
    setCoords({ x: String(initialTarget.x), y: String(initialTarget.y), z: String(initialTarget.z) });
    setResult(null); setError(null);
  }, [initialTarget]);

  const prevTarget = useRef<typeof initialTarget>(null);
  useEffect(() => {
    if (!initialTarget || prevTarget.current === initialTarget) return;
    prevTarget.current = initialTarget;
    doScout(initialTarget.x, initialTarget.y, initialTarget.z);
  }, [initialTarget, doScout]);

  const scout = () => {
    const x = parseInt(coords.x, 10), y = parseInt(coords.y, 10), z = parseInt(coords.z, 10);
    if ([x, y, z].some(isNaN)) { setError("Enter valid integers for x, y, z"); return; }
    doScout(x, y, z);
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

      {result?.unavailable && (
        <div className="flex items-start gap-2 text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/20 rounded p-2">
          <span className="mt-0.5">⏳</span>
          <div>
            <div>Sensor data not ready — probe still collecting readings for this sector.</div>
            {result.retryIn && (
              <div className="text-muted-foreground mt-0.5">Try again in {result.retryIn}.</div>
            )}
          </div>
        </div>
      )}

      {result && !result.unavailable && (
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

function fmtTime(secs: number): string {
  if (secs <= 0) return "0s";
  if (secs < 60) return `${Math.round(secs)}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

type CraftIngredient = {
  kind: "resource" | "item";
  type: string;
  quantity: number;
  unit?: string;
  have: number;
  missing: number;
  satisfied: boolean;
};

type CraftRecipe = {
  id: string;
  name: string;
  craftableBy: string[];
  durationSeconds: number;
  ingredients: CraftIngredient[];
  canCraftNow: boolean;
  totalTimeSeconds: number;
  missingResources: { type: string; need: number; have: number }[];
};

function CraftingCalcPanel({ probeId }: { probeId: number | null }) {
  const [machineFilter, setMachineFilter] = useState<"all" | "manny" | "printer">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [queueStatus, setQueueStatus] = useState<Map<string, "loading" | "ok" | "err">>(new Map());
  const [queueQty, setQueueQty] = useState<Map<string, number>>(new Map());
  const [queueToast, setQueueToast] = useState<{ count: number; name: string } | null>(null);

  const queueItem = async (r: CraftRecipe) => {
    const qty = Math.max(1, queueQty.get(r.id) ?? 1);
    setQueueStatus((prev) => new Map(prev).set(r.id, "loading"));
    try {
      const result = await fetchJson(`${BASE}/api/vng/log/crafting-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipeId: r.id,
          quantity: qty,
          ...(probeId != null ? { probeId } : {}),
        }),
      });
      setQueueStatus((prev) => new Map(prev).set(r.id, "ok"));
      setQueueToast({ count: result.queued ?? qty, name: r.name });
      setTimeout(() => setQueueToast(null), 5000);
      setTimeout(
        () => setQueueStatus((prev) => { const n = new Map(prev); n.delete(r.id); return n; }),
        3000
      );
    } catch {
      setQueueStatus((prev) => new Map(prev).set(r.id, "err"));
      setTimeout(
        () => setQueueStatus((prev) => { const n = new Map(prev); n.delete(r.id); return n; }),
        3000
      );
    }
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["crafting-calc", probeId],
    queryFn: () =>
      fetchJson(
        `${BASE}/api/vng/log/crafting-calc${probeId != null ? `?probeId=${probeId}` : ""}`
      ),
    refetchInterval: 30000,
    staleTime: 20000,
  });

  const allRecipes: CraftRecipe[] = data?.recipes ?? [];
  const inventoryItems: Record<string, number> = data?.inventory?.items ?? {};

  const filtered = allRecipes.filter((r) => {
    if (machineFilter === "manny") return r.craftableBy.includes("manny");
    if (machineFilter === "printer") return r.craftableBy.includes("atomic_3d_printer");
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    // Priority: can craft now → in stock (total=0) → by total time ascending
    if (a.canCraftNow !== b.canCraftNow) return a.canCraftNow ? -1 : 1;
    const aStocked = a.totalTimeSeconds === 0;
    const bStocked = b.totalTimeSeconds === 0;
    if (aStocked !== bStocked) return aStocked ? -1 : 1;
    return a.totalTimeSeconds - b.totalTimeSeconds;
  });

  const readyCount = allRecipes.filter((r) => r.canCraftNow).length;
  const stockedCount = allRecipes.filter((r) => !r.canCraftNow && r.totalTimeSeconds === 0).length;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      {/* Queue confirmation toast — fixed so it floats over content without shifting layout */}
      {queueToast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded border border-green-800/50 bg-green-950/95 shadow-lg text-[10px] max-w-xs">
          <span className="text-green-400">✓</span>
          <span className="text-green-300/80 flex-1">
            <span className="font-semibold">{queueToast.count} task{queueToast.count !== 1 ? "s" : ""}</span> queued for <span className="font-semibold">{queueToast.name}</span> — idle Mannies will self-assign
          </span>
          <button onClick={() => setQueueToast(null)} className="text-green-600/60 hover:text-green-400 ml-1">✕</button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground tracking-widest">CRAFTING CALCULATOR</div>
        {!isLoading && !error && (
          <span className="text-[9px] text-muted-foreground/50 space-x-1.5">
            {readyCount > 0 && <span className="text-green-400/70">{readyCount} ready</span>}
            {stockedCount > 0 && <span className="text-blue-400/60">{stockedCount} stocked</span>}
            <span>{allRecipes.length} total</span>
          </span>
        )}
      </div>

      <div className="flex gap-1">
        {(["all", "manny", "printer"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setMachineFilter(f)}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
              machineFilter === f
                ? "border-primary/50 text-primary bg-primary/10"
                : "border-border/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            {f === "all" ? "ALL" : f === "manny" ? "MANNY" : "PRINTER"}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>
      )}
      {error && <ApiError error={error as Error} />}

      {!isLoading && !error && (
        <div className="space-y-0.5">
          {sorted.map((r) => {
            const isExpanded = expanded.has(r.id);
            const machine = r.craftableBy.includes("atomic_3d_printer") ? "PRINT" : "MANNY";
            const stockCount = inventoryItems[r.id] ?? 0;
            const isStocked = r.totalTimeSeconds === 0 && stockCount > 0;
            const subCraftSecs = Math.max(0, r.totalTimeSeconds - r.durationSeconds);
            const hasSubCrafts = subCraftSecs > 1;

            // Time label: stocked items show "×N stocked", others show total time
            const timeLabel = isStocked
              ? null
              : hasSubCrafts
              ? `${fmtTime(r.durationSeconds)} +${fmtTime(subCraftSecs)}`
              : fmtTime(r.durationSeconds);

            return (
              <div key={r.id} className={`border rounded overflow-hidden ${
                r.canCraftNow ? "border-green-900/50" : isStocked ? "border-blue-900/30" : "border-border/30"
              }`}>
                <div className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-primary/5 transition-colors">
                  {/* Expand/collapse zone — takes all space except the + button */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggle(r.id)}
                    onKeyDown={(e) => e.key === "Enter" && toggle(r.id)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer"
                  >
                    <span className={`text-[9px] font-mono w-3 shrink-0 ${
                      r.canCraftNow ? "text-green-400" : isStocked ? "text-blue-400/60" : "text-muted-foreground/30"
                    }`}>
                      {r.canCraftNow ? "✓" : isStocked ? "■" : "○"}
                    </span>
                    <span className="text-[10px] text-foreground flex-1 min-w-0 truncate">
                      {r.name}
                    </span>
                    {stockCount > 0 && (
                      <span className="text-[9px] text-blue-400/60 font-mono shrink-0">×{stockCount}</span>
                    )}
                    <span className="text-[9px] text-muted-foreground/40 shrink-0 font-mono">{machine}</span>
                    {timeLabel ? (
                      <span className={`text-[9px] font-mono shrink-0 tabular-nums ${
                        r.canCraftNow ? "text-green-400/80" : hasSubCrafts ? "text-amber-300/60" : "text-muted-foreground/50"
                      }`}>
                        {timeLabel}
                      </span>
                    ) : (
                      <span className="text-[9px] text-blue-400/40 font-mono shrink-0">stocked</span>
                    )}
                    <span className="text-[8px] text-muted-foreground/30 shrink-0">{isExpanded ? "▲" : "▼"}</span>
                  </div>
                  {/* Quantity + queue button */}
                  <input
                    type="number"
                    min={1}
                    value={queueQty.get(r.id) ?? 1}
                    onChange={(e) => {
                      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
                      setQueueQty((prev) => new Map(prev).set(r.id, v));
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 w-8 h-5 text-center text-[10px] bg-black/30 border border-border/40 rounded text-foreground focus:outline-none focus:border-primary/50 tabular-nums"
                  />
                  <button
                    onClick={() => queueItem(r)}
                    disabled={queueStatus.get(r.id) === "loading"}
                    title="Add to craft queue"
                    className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold transition-colors ${
                      queueStatus.get(r.id) === "ok"
                        ? "text-green-400 bg-green-900/30"
                        : queueStatus.get(r.id) === "err"
                        ? "text-red-400 bg-red-900/30"
                        : queueStatus.get(r.id) === "loading"
                        ? "text-muted-foreground/40 cursor-wait"
                        : "text-primary/50 hover:text-primary hover:bg-primary/10"
                    }`}
                  >
                    {queueStatus.get(r.id) === "loading"
                      ? "…"
                      : queueStatus.get(r.id) === "ok"
                      ? "✓"
                      : queueStatus.get(r.id) === "err"
                      ? "!"
                      : "+"}
                  </button>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-2 pt-1 space-y-1 border-t border-border/20 bg-black/20">
                    {r.ingredients.length === 0 && (
                      <div className="text-[9px] text-muted-foreground/40 italic">No ingredients required.</div>
                    )}
                    {r.ingredients.map((ing, i) => {
                      const label =
                        ing.kind === "resource"
                          ? `${ing.quantity} ECE ${ing.type.replace(/_/g, " ")}`
                          : `${ing.quantity}× ${ing.type.replace(/_/g, " ")}`;
                      return (
                        <div key={i} className="flex items-center gap-2 text-[9px]">
                          <span className={`shrink-0 ${ing.satisfied ? "text-green-400/60" : "text-red-400/60"}`}>
                            {ing.satisfied ? "✓" : "✗"}
                          </span>
                          <span className="text-muted-foreground font-mono flex-1 min-w-0 truncate">{label}</span>
                          <span className="text-muted-foreground/40 shrink-0 tabular-nums">
                            {ing.kind === "resource"
                              ? `${ing.have.toFixed(3)}/${ing.quantity} ECE`
                              : `${ing.have}/${ing.quantity}`}
                            {!ing.satisfied && (
                              <span className="text-amber-400/60 ml-1">
                                (need {ing.kind === "resource" ? (ing.missing as number).toFixed(3) : ing.missing} more)
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}

                    {r.missingResources.length > 0 && (
                      <div className="text-[9px] text-amber-400/50 pt-1 border-t border-border/20">
                        ⚠ need raw resources:{" "}
                        {r.missingResources
                          .map((m) => `${(m.need - m.have).toFixed(3)} ECE ${m.type.replace(/_/g, " ")}`)
                          .join(", ")}
                      </div>
                    )}

                    <div className="text-[9px] text-muted-foreground/30 pt-0.5 border-t border-border/20 flex gap-3 tabular-nums">
                      <span>build: {fmtTime(r.durationSeconds)}</span>
                      {hasSubCrafts && <span>sub-crafts: +{fmtTime(subCraftSecs)}</span>}
                      {r.totalTimeSeconds > 0 && <span className="text-muted-foreground/50">total: {fmtTime(r.totalTimeSeconds)}</span>}
                      {isStocked && <span className="text-blue-400/50">{stockCount}× in stock</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {sorted.length === 0 && (
            <div className="text-[10px] text-muted-foreground/40 italic">No recipes found.</div>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduledPanel({ refetchSignal }: { refetchSignal: number }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["scheduled-actions", refetchSignal],
    queryFn: () => fetchJson(`${BASE}/api/vng/scheduled`),
    refetchInterval: 15000,
  });

  const actions: any[] = data?.actions ?? [];

  const cancel = async (id: number) => {
    await fetch(`${BASE}/api/vng/scheduled/${id}`, { method: "DELETE" });
    refetch();
  };

  if (isLoading) return <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>;
  if (error) return <ApiError error={error as Error} />;

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground tracking-widest">SCHEDULED ACTIONS</div>
      <div className="text-[10px] text-muted-foreground/50">
        The poller checks every 30 s and fires when the condition is met.
      </div>
      {actions.length === 0 ? (
        <div className="text-xs text-muted-foreground/40 italic">No pending actions.</div>
      ) : (
        <div className="space-y-2">
          {actions.map((a: any) => {
            const cond = a.condition?.type === "manny_idle"
              ? `when ${a.condition.mannyName ?? a.condition.mannyId} is idle`
              : a.condition?.type === "probe_idle"
              ? "when probe is idle"
              : a.condition?.type ?? "?";
            return (
              <div key={a.id} className="border border-border rounded p-2 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-foreground font-mono">#{a.id}</span>
                  <button
                    onClick={() => cancel(a.id)}
                    className="text-[10px] text-destructive hover:text-destructive/70 transition-colors shrink-0"
                    title="Cancel"
                  >
                    ✕
                  </button>
                </div>
                <div className="text-xs text-primary/90">{a.description}</div>
                <div className="text-[10px] text-muted-foreground">⏳ {cond}</div>
                <div className="text-[10px] text-muted-foreground/50 font-mono">
                  action: {a.action?.type}
                  {a.action?.type === "move_probe" ? ` → (${a.action.x},${a.action.y},${a.action.z})` : ""}
                </div>
              </div>
            );
          })}
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
  const [scoutTarget, setScoutTarget] = useState<{ x: number; y: number; z: number } | null>(null);
  const [selectedProbeId, setSelectedProbeId] = useState<number | null>(null);

  // Fill-window-width preference. Pane sizes persist via the panel group's
  // autoSaveId; this boolean is the only value we hand-persist.
  const [fillWidth, setFillWidth] = useState<boolean>(() => {
    try { return localStorage.getItem("pc-fill-width") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("pc-fill-width", fillWidth ? "1" : "0"); } catch {}
  }, [fillWidth]);
  const isDesktop = useIsDesktop();

  const handleScoutRequest = useCallback((x: number, y: number, z: number) => {
    setScoutTarget({ x, y, z });
    setSideTab("scout");
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: probeListData } = useQuery({
    queryKey: ["probe-list"],
    queryFn: () => fetchJson(`${BASE}/api/vng/probes`),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const probeList: ProbeEntry[] = (probeListData?.probes ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    isDefault: p.isDefault ?? (p.id === probeListData?.defaultProbeId),
  }));

  const { data: state, error: stateError } = useQuery({
    queryKey: ["probe-state", selectedProbeId],
    queryFn: () => fetchJson(
      `${BASE}/api/vng/state${selectedProbeId ? `?probeId=${selectedProbeId}` : ""}`
    ),
    refetchInterval: 30000,
    retry: 1,
  });

  const queryClient = useQueryClient();

  // Fetch globe sectors at Commander level so GlobeMap always receives live data
  // immediately when the tab opens, regardless of when the user navigates to it.
  const { data: sectorsData } = useQuery({
    queryKey: ["sectors-globe"],
    queryFn: () => fetchJson(`${BASE}/api/vng/log/sectors`, { cache: "no-store" }),
    retry: 1,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Scan all visited sectors via SCUT/scout API, then refetch globe data
  const handleRefreshSectors = useCallback(async () => {
    const r = await fetch(`${BASE}/api/vng/log/sectors/refresh`, { method: "POST" });
    if (!r.ok) throw new Error(`Refresh failed: ${r.status}`);
    await queryClient.invalidateQueries({ queryKey: ["sectors-globe"] });
    await queryClient.refetchQueries({ queryKey: ["sectors-globe"] });
  }, [queryClient]);

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
        body: JSON.stringify({ command: cmd, probeId: selectedProbeId }),
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
  }, [input, isRunning, selectedProbeId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCommand(); }
  };

  const globeCenter = useMemo(() => {
    const mv = state?.probe?.movement;
    // Active-transit statuses per the ProbeMovement.status enum. ("moving" is
    // kept as a defensive superset in case live values ever differ from spec —
    // the previous `=== "moving"` alone matched no real enum value.)
    const ACTIVE = ["preparing", "accelerating", "cruising", "decelerating", "moving"];
    const inTransit = ACTIVE.includes(mv?.status) || ACTIVE.includes(state?.probe?.status);
    // prior = last known departure point (from any completed or in-progress trip)
    const px = mv?.origin?.x, py = mv?.origin?.y, pz = mv?.origin?.z;
    const hasPrior = px !== undefined && py !== undefined && pz !== undefined;
    if (inTransit && mv?.target) return {
      x: mv.target.x, y: mv.target.y, z: mv.target.z,
      isMoving: true,
      px: hasPrior ? px : undefined, py: hasPrior ? py : undefined, pz: hasPrior ? pz : undefined,
    };
    const s = state?.probe?.sector ?? { x: 0, y: 0, z: 0 };
    return {
      x: s.x, y: s.y, z: s.z, isMoving: false,
      px: hasPrior ? px : undefined, py: hasPrior ? py : undefined, pz: hasPrior ? pz : undefined,
    };
  }, [state]);

  const TABS: { id: SideTab; label: string }[] = [
    { id: "telemetry", label: "PROBE" },
    { id: "containers", label: "CNTRS" },
    { id: "sectors", label: "MAP" },
    { id: "scout", label: "SCOUT" },
    { id: "globe", label: "GLOBE" },
    { id: "system", label: "SYS" },
    { id: "scheduled", label: "SCHED" },
  ];

  const leftContent = (
    <>
      <div className="text-xs text-muted-foreground tracking-[0.3em] glow-green">
        VON NEUMANN PROBE
      </div>
      {/* Tab bar */}
      <div className="flex border border-border rounded overflow-hidden">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setSideTab(tab.id)}
            className={`flex-1 py-1.5 px-0.5 text-[10px] tracking-wide whitespace-nowrap transition-all ${
              sideTab === tab.id
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* min-h-0 + overflow-y-auto: react-resizable-panels forces overflow:hidden
          on the panel, so tab content must scroll here, inside the panel. */}
      <div className="border border-border border-glow rounded p-4 flex-1 min-h-0 overflow-y-auto scanlines">
        {sideTab === "telemetry" && (
          <TelemetryPanel
            state={state}
            error={stateError as Error | null}
            probeList={probeList}
            selectedProbeId={selectedProbeId}
            onSelectProbe={setSelectedProbeId}
          />
        )}
        {sideTab === "containers" && <ContainersPanel refetchSignal={logRefetch} probeId={selectedProbeId} />}
        {sideTab === "sectors" && <SectorsPanel refetchSignal={logRefetch} />}
        {sideTab === "scout" && <ScoutPanel initialTarget={scoutTarget} />}
        {sideTab === "scheduled" && (
          <>
            <CraftingCalcPanel probeId={selectedProbeId} />
            <div className="my-3 border-t border-border/30" />
            <ScheduledPanel refetchSignal={logRefetch} />
          </>
        )}
        {sideTab === "globe" && (
          <GlobeMap
            probeX={globeCenter.x}
            probeY={globeCenter.y}
            probeZ={globeCenter.z}
            isMoving={globeCenter.isMoving}
            priorX={globeCenter.px}
            priorY={globeCenter.py}
            priorZ={globeCenter.pz}
            sectorsData={sectorsData}
            onRefreshSectors={handleRefreshSectors}
          />
        )}
        {sideTab === "system" && (
          <SystemMap
            probe={state?.probe}
            sectorObjects={state?.sectorObjects}
            otherProbes={state?.otherProbes}
            mannies={state?.mannies}
            isMoving={globeCenter.isMoving}
            sectorUnavailable={state?.sectorUnavailable}
            onScoutRequest={handleScoutRequest}
          />
        )}
      </div>

      <div className="text-xs text-muted-foreground text-center tracking-widest opacity-40">
        AUTO-REFRESH 30s
      </div>
    </>
  );

  const rightContent = (
    <>
      <div className="text-xs text-muted-foreground tracking-[0.3em] mb-3 glow-cyan">
        OPERATOR TERMINAL
      </div>

      <div className="flex-1 min-h-0 border border-border border-glow rounded overflow-y-auto p-4 space-y-4 bg-card/30 scanlines">
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
    </>
  );

  return (
    <>
      <button
        onClick={() => setFillWidth(v => !v)}
        aria-pressed={fillWidth}
        aria-label={fillWidth ? "Constrain width" : "Fill window width"}
        title={fillWidth ? "Constrain width" : "Fill window width"}
        className="fixed top-2 right-2 z-50 p-1.5 border border-border rounded bg-card/60 text-muted-foreground transition-all hover:text-primary hover:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {fillWidth ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>

      <div className={cn("h-screen flex flex-col p-4", !fillWidth && "max-w-7xl mx-auto")}>
        {isDesktop ? (
          // Left panel takes most space; right terminal is smaller but still draggable.
          <ResizablePanelGroup direction="horizontal" autoSaveId="pc-panes" className="h-full">
            <ResizablePanel defaultSize={72} minSize={40} className="flex flex-col gap-2 min-h-0">
              {leftContent}
            </ResizablePanel>
            <ResizableHandle withHandle className="mx-2" />
            <ResizablePanel defaultSize={28} minSize={18} maxSize={50} className="flex flex-col min-h-0">
              {rightContent}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">{leftContent}</div>
            <div className="flex flex-col min-h-[70vh]">{rightContent}</div>
          </div>
        )}
      </div>
    </>
  );
}
