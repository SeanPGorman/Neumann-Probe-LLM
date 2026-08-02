import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  return json as T;
}

const MATERIALS = [
  { value: "metals",           label: "Metals",           color: "text-orange-400" },
  { value: "ice",              label: "Ice",               color: "text-blue-300" },
  { value: "carbon_compounds", label: "Carbon / Organics", color: "text-green-400" },
  { value: "deuterium",        label: "Deuterium",         color: "text-yellow-400" },
];

function materialLabel(m: string) {
  return MATERIALS.find((x) => x.value === m)?.label ?? m;
}
function materialColor(m: string) {
  return MATERIALS.find((x) => x.value === m)?.color ?? "text-muted-foreground";
}

function cycleStateBadge(state: string) {
  switch (state) {
    case "mining":
      return <span className="text-[9px] px-1.5 py-0.5 rounded border border-amber-600/50 text-amber-400 bg-amber-950/40">⛏ MINING</span>;
    case "recovering":
      return <span className="text-[9px] px-1.5 py-0.5 rounded border border-blue-600/50 text-blue-400 bg-blue-950/40">↑ RECOVERING</span>;
    default:
      return <span className="text-[9px] px-1.5 py-0.5 rounded border border-border/40 text-muted-foreground">● IDLE</span>;
  }
}

interface Props {
  probeId: number | null;
}

export function MiningPanel({ probeId }: Props) {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formContainerId, setFormContainerId] = useState("");
  const [formMaterial, setFormMaterial] = useState("metals");
  const [formMannyCount, setFormMannyCount] = useState(4);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const qk = ["mining", probeId];

  const { data, isLoading, error } = useQuery({
    queryKey: qk,
    queryFn: () =>
      fetchJson(
        `${BASE}/api/vng/log/mining${probeId != null ? `?probeId=${probeId}` : ""}`
      ),
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: qk });
    setIsRefreshing(false);
  }, [queryClient, probeId]);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  const assignments: any[] = data?.assignments ?? [];
  const asteroids: any[] = data?.asteroids ?? [];
  const containers: any[] = data?.containers ?? [];
  const mannies: any[] = data?.mannies ?? [];

  // Containers not yet assigned (available for new assignments)
  const assignedContainerIds = new Set(assignments.map((a) => a.containerId));
  const availableContainers = containers.filter((c) => !assignedContainerIds.has(c.id));

  // Resource types present in sector asteroids
  const sectorMaterials = new Set<string>(
    asteroids.flatMap((a) => a.resourceTypes ?? [])
  );

  const createAssignment = async () => {
    if (!formContainerId) return;
    setSaving(true);
    try {
      const selectedContainer = containers.find((c) => c.id === formContainerId);
      await fetchJson(`${BASE}/api/vng/log/mining`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          containerId: formContainerId,
          containerName: selectedContainer?.label ?? formContainerId,
          material: formMaterial,
          mannyCount: formMannyCount,
          probeId,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: qk });
      setShowForm(false);
      setFormContainerId("");
      toast("Assignment created");
    } catch (e: any) {
      toast(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (id: number, enabled: boolean) => {
    try {
      await fetchJson(`${BASE}/api/vng/log/mining/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await queryClient.invalidateQueries({ queryKey: qk });
    } catch (e: any) {
      toast(`Error: ${e.message}`);
    }
  };

  const updateMannyCount = async (id: number, mannyCount: number) => {
    try {
      await fetchJson(`${BASE}/api/vng/log/mining/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mannyCount }),
      });
      await queryClient.invalidateQueries({ queryKey: qk });
    } catch (e: any) {
      toast(`Error: ${e.message}`);
    }
  };

  const resetCycle = async (id: number) => {
    try {
      await fetchJson(`${BASE}/api/vng/log/mining/${id}/reset`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: qk });
      toast("Cycle reset to idle");
    } catch (e: any) {
      toast(`Error: ${e.message}`);
    }
  };

  const deleteAssignment = async (id: number) => {
    try {
      await fetchJson(`${BASE}/api/vng/log/mining/${id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk });
      toast("Assignment removed");
    } catch (e: any) {
      toast(`Error: ${e.message}`);
    }
  };

  return (
    <div className="space-y-4 pb-4">
      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-4 right-4 z-50 px-3 py-2 rounded border border-green-800/50 bg-green-950/95 text-[10px] text-green-300/80 shadow-lg">
          {toastMsg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground tracking-widest">MINING AUTOMATION</div>
        <button
          onClick={refresh}
          disabled={isRefreshing || isLoading}
          className="text-[10px] font-mono px-1.5 h-5 flex items-center gap-1 rounded border border-border/40 text-cyan-500/70 hover:text-cyan-400 hover:border-cyan-500/40 disabled:opacity-40 transition-colors"
        >
          {isRefreshing ? "…" : "↺"} REFRESH
        </button>
      </div>

      {isLoading && (
        <div className="text-xs text-muted-foreground italic animate-pulse">LOADING…</div>
      )}
      {error && (
        <div className="text-xs text-red-400/80">Error: {(error as Error).message}</div>
      )}

      {/* Sector asteroids */}
      {!isLoading && (
        <div>
          <div className="text-[9px] text-muted-foreground/50 tracking-widest mb-1">
            SECTOR ASTEROIDS ({asteroids.length})
          </div>
          {asteroids.length === 0 ? (
            <div className="text-[10px] text-muted-foreground/40 italic">No mineable asteroids in current sector</div>
          ) : (
            <div className="space-y-0.5">
              {asteroids.map((a) => (
                <div key={a.id} className="flex items-start gap-2 text-[10px]">
                  <span className="text-muted-foreground/40 shrink-0">◆</span>
                  <span className="text-muted-foreground/70 truncate">{a.name}</span>
                  <div className="flex gap-1 ml-auto shrink-0">
                    {(a.resourceTypes ?? []).map((r: string) => (
                      <span key={r} className={`${materialColor(r)} opacity-80`}>
                        {materialLabel(r)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Assignments */}
      <div>
        <div className="text-[9px] text-muted-foreground/50 tracking-widest mb-2">
          ASSIGNMENTS ({assignments.length})
        </div>
        <div className="space-y-2">
          {assignments.map((a) => {
            const inSector = sectorMaterials.has(a.material);
            const perManny = a.mannyCount > 0
              ? `${(1 / a.mannyCount * 100).toFixed(0)}% each`
              : "";
            const miningMannies = mannies.filter(
              (m) => (a.miningMannyIds ?? []).includes(m.id)
            );
            const idleMiners = miningMannies.filter((m) => !m.currentTask).length;

            return (
              <div
                key={a.id}
                className={`rounded border p-2 space-y-2 ${
                  a.enabled
                    ? "border-border/40 bg-card/20"
                    : "border-border/20 opacity-50"
                }`}
              >
                {/* Top row: name + state + toggle */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-foreground/80 font-mono truncate flex-1">
                    {a.containerName}
                  </span>
                  {cycleStateBadge(a.cycleState)}
                  <button
                    onClick={() => toggleEnabled(a.id, !a.enabled)}
                    className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                      a.enabled
                        ? "border-green-700/50 text-green-400 hover:border-green-600"
                        : "border-border/30 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {a.enabled ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Material + manny count */}
                <div className="flex items-center gap-3 text-[10px]">
                  <span className={materialColor(a.material)}>{materialLabel(a.material)}</span>
                  {!inSector && a.enabled && (
                    <span className="text-amber-500/70 text-[9px]">⚠ not in sector</span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <span className="text-muted-foreground/50">mannies:</span>
                    <button
                      onClick={() => updateMannyCount(a.id, Math.max(1, a.mannyCount - 1))}
                      className="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground border border-border/30 rounded text-[10px]"
                    >−</button>
                    <span className="w-4 text-center font-mono text-foreground/80">{a.mannyCount}</span>
                    <button
                      onClick={() => updateMannyCount(a.id, Math.min(10, a.mannyCount + 1))}
                      className="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground border border-border/30 rounded text-[10px]"
                    >+</button>
                    <span className="text-muted-foreground/40 ml-1">{perManny}</span>
                  </div>
                </div>

                {/* Active mining mannies */}
                {a.cycleState === "mining" && miningMannies.length > 0 && (
                  <div className="text-[9px] text-muted-foreground/60 space-y-0.5">
                    {miningMannies.map((m) => (
                      <div key={m.id} className="flex items-center gap-2">
                        <span className={m.currentTask ? "text-amber-400/70" : "text-green-400/60"}>
                          {m.currentTask ? "⛏" : "✓"}
                        </span>
                        <span className="truncate">{m.name}</span>
                        {m.taskProgressPercent != null && m.currentTask && (
                          <span className="ml-auto tabular-nums">{Math.round(m.taskProgressPercent)}%</span>
                        )}
                        {!m.currentTask && (
                          <span className="ml-auto text-green-400/60">done</span>
                        )}
                      </div>
                    ))}
                    <div className="text-muted-foreground/40 pt-0.5">
                      {idleMiners}/{miningMannies.length} miners done
                    </div>
                  </div>
                )}

                {/* Last error */}
                {a.lastError && (
                  <div className="text-[9px] text-red-400/70 truncate">⚠ {a.lastError}</div>
                )}

                {/* Actions */}
                <div className="flex gap-1 pt-0.5">
                  {(a.cycleState === "mining" || a.cycleState === "recovering") && (
                    <button
                      onClick={() => resetCycle(a.id)}
                      className="text-[9px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground hover:text-amber-400 hover:border-amber-600/40 transition-colors"
                    >
                      ↺ RESET
                    </button>
                  )}
                  <button
                    onClick={() => deleteAssignment(a.id)}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground hover:text-red-400 hover:border-red-600/40 transition-colors ml-auto"
                  >
                    ✕ REMOVE
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add assignment form */}
      {!showForm ? (
        <button
          onClick={() => {
            setFormContainerId(availableContainers[0]?.id ?? "");
            setShowForm(true);
          }}
          disabled={availableContainers.length === 0}
          className="w-full text-[10px] font-mono py-1.5 rounded border border-dashed border-border/40 text-muted-foreground/60 hover:text-primary hover:border-primary/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          + ADD ASSIGNMENT
          {availableContainers.length === 0 && " (no free containers)"}
        </button>
      ) : (
        <div className="rounded border border-border/40 p-2 space-y-2 bg-card/20">
          <div className="text-[9px] text-muted-foreground/50 tracking-widest">NEW ASSIGNMENT</div>

          {/* Container */}
          <div className="space-y-0.5">
            <label className="text-[9px] text-muted-foreground/50">CONTAINER</label>
            <select
              value={formContainerId}
              onChange={(e) => setFormContainerId(e.target.value)}
              className="w-full text-[10px] bg-background border border-border/40 rounded px-1.5 py-1 text-foreground"
            >
              {availableContainers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({(c.capacity ?? 0).toFixed(2)} ECE)
                </option>
              ))}
            </select>
          </div>

          {/* Material */}
          <div className="space-y-0.5">
            <label className="text-[9px] text-muted-foreground/50">MATERIAL</label>
            <div className="flex flex-wrap gap-1">
              {MATERIALS.map((m) => {
                const available = sectorMaterials.has(m.value);
                return (
                  <button
                    key={m.value}
                    onClick={() => setFormMaterial(m.value)}
                    className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
                      formMaterial === m.value
                        ? "border-primary/50 text-primary bg-primary/10"
                        : "border-border/30 text-muted-foreground hover:text-foreground"
                    } ${!available ? "opacity-40" : ""}`}
                  >
                    {m.label}{!available ? " ✗" : " ✓"}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Manny count */}
          <div className="space-y-0.5">
            <label className="text-[9px] text-muted-foreground/50">MANNIES</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={formMannyCount}
                onChange={(e) => setFormMannyCount(parseInt(e.target.value))}
                className="flex-1 h-1 accent-primary"
              />
              <span className="text-[10px] font-mono w-16 text-right text-foreground/70">
                {formMannyCount} × {(1 / formMannyCount * 100).toFixed(0)}%
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-1 pt-1">
            <button
              onClick={createAssignment}
              disabled={saving || !formContainerId}
              className="flex-1 text-[10px] py-1 rounded border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-40 transition-colors"
            >
              {saving ? "SAVING…" : "CREATE"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-3 text-[10px] py-1 rounded border border-border/30 text-muted-foreground hover:text-foreground transition-colors"
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Manny status */}
      {mannies.length > 0 && (
        <div>
          <div className="text-[9px] text-muted-foreground/50 tracking-widest mb-1">
            MANNIES ({mannies.length})
          </div>
          <div className="space-y-0.5">
            {mannies.map((m) => (
              <div key={m.id} className="flex items-center gap-2 text-[10px]">
                <span className={`shrink-0 ${m.currentTask ? "text-amber-400/70" : "text-green-400/50"}`}>
                  {m.currentTask ? "⛏" : "○"}
                </span>
                <span className="text-muted-foreground/70 truncate flex-1">{m.name}</span>
                {m.currentTask ? (
                  <span className="text-[9px] text-amber-400/60 shrink-0">
                    {String(m.currentTask).replace(/_/g, " ")}
                    {m.taskProgressPercent != null ? ` ${Math.round(m.taskProgressPercent)}%` : ""}
                  </span>
                ) : (
                  <span className="text-[9px] text-green-400/50 shrink-0">idle</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
