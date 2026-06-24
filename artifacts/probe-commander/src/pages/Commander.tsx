import { useState, useEffect, useRef, useCallback } from "react";
import { useGetProbeState } from "@workspace/api-client-react";

type SseEvent =
  | { type: "status"; message: string }
  | { type: "thinking"; content: string }
  | { type: "message"; content: string }
  | { type: "action"; tool: string; params: Record<string, unknown>; id: string }
  | { type: "result"; tool: string; id: string; success: boolean; data?: unknown; error?: string }
  | { type: "error"; message: string }
  | { type: "done" };

type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; events: SseEvent[] };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

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

function ProbePanel({ state }: { state: any }) {
  if (!state) {
    return (
      <div className="border border-border border-glow rounded p-4 space-y-2 animate-pulse">
        <div className="text-xs text-muted-foreground">LOADING TELEMETRY…</div>
      </div>
    );
  }

  const { probe, mannies, sectorObjects } = state;
  const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };

  return (
    <div className="border border-border border-glow rounded p-4 space-y-4 scanlines">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tracking-widest">PROBE TELEMETRY</span>
        <span className="text-xs text-primary glow-green">{probe.status?.toUpperCase()}</span>
      </div>

      <div>
        <div className="text-lg font-bold glow-green tracking-wider">{probe.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          SECTOR [{sector.x},{sector.y},{sector.z}]
        </div>
      </div>

      <div className="space-y-2">
        <GaugeBar label="FUEL" value={probe.fuelPercent} />
        <GaugeBar label="HULL" value={probe.integrityPercent} />
      </div>

      {mannies.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground tracking-widest mb-2">MANNIES ({mannies.length})</div>
          <div className="space-y-1.5">
            {mannies.map((m: any) => (
              <MannyRow key={m.id} manny={m} />
            ))}
          </div>
        </div>
      )}

      {sectorObjects.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground tracking-widest mb-2">
            SECTOR OBJECTS ({sectorObjects.length})
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
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

function GaugeBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const color =
    pct > 50 ? "hsl(150 80% 45%)" : pct > 25 ? "hsl(45 90% 50%)" : "hsl(0 70% 50%)";
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span style={{ color }}>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
    </div>
  );
}

function MannyRow({ manny }: { manny: any }) {
  const idle = !manny.currentTask;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={idle ? "text-primary" : "text-yellow-400 pulse-active"}>
        {idle ? "●" : "◌"}
      </span>
      <span className="text-foreground font-medium truncate max-w-[90px]">{manny.name}</span>
      <span className="text-muted-foreground truncate">
        {idle
          ? "IDLE"
          : `${manny.currentTask?.toUpperCase().replace(/_/g, " ")} ${manny.taskProgressPercent?.toFixed(0)}%`}
      </span>
    </div>
  );
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

function EventRow({ event }: { event: SseEvent }) {
  if (event.type === "status") {
    return (
      <div className="text-xs text-muted-foreground italic">
        ▸ {event.message}
      </div>
    );
  }
  if (event.type === "message") {
    return (
      <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
        {event.content}
      </div>
    );
  }
  if (event.type === "action") {
    const paramStr = Object.entries(event.params)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return (
      <div className="flex flex-col gap-0.5 py-1 border-l-2 border-accent pl-3">
        <div className="text-xs text-accent font-bold tracking-wider">
          ⟶ {toolLabel(event.tool)}
        </div>
        {paramStr && (
          <div className="text-xs text-muted-foreground font-mono break-all">{paramStr}</div>
        )}
      </div>
    );
  }
  if (event.type === "result") {
    if (!event.success) {
      return (
        <div className="text-xs text-destructive pl-3 border-l-2 border-destructive">
          ✕ ERROR: {event.error}
        </div>
      );
    }
    return (
      <div className="text-xs text-primary pl-3 border-l-2 border-primary">
        ✓ {toolLabel(event.tool)} OK
      </div>
    );
  }
  if (event.type === "error") {
    return (
      <div className="text-xs text-destructive glow-red">
        ⚠ {event.message}
      </div>
    );
  }
  return null;
}

function AssistantBubble({ events }: { events: SseEvent[] }) {
  const messageEvents = events.filter(
    (e) => e.type === "message" || e.type === "action" || e.type === "result" || e.type === "status" || e.type === "error"
  );
  if (messageEvents.length === 0) return null;
  return (
    <div className="space-y-1.5 border border-border rounded p-3 bg-card/60 border-glow">
      {messageEvents.map((e, i) => (
        <EventRow key={i} event={e} />
      ))}
    </div>
  );
}

export default function Commander() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      events: [
        {
          type: "message",
          content:
            "PROBE COMMANDER ONLINE.\n\nI have direct access to your probe's systems. Give me a natural language command and I will execute the necessary operations.\n\nExamples:\n• \"Have a Manny craft an additional container, then detach it and mine 1 container of metals from the nearest asteroid\"\n• \"Repair Manny-1 to full integrity\"\n• \"Scan the sector and tell me what resources are available\"",
        },
      ],
    },
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [liveEvents, setLiveEvents] = useState<SseEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: state, refetch: refetchState } = useGetProbeState({
    query: { refetchInterval: 30000 },
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

    setMessages((prev) => [...prev, { role: "user", content: cmd }]);

    const events: SseEvent[] = [];

    try {
      const res = await fetch(`${BASE}/api/vng/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Server error: ${res.status}`);
      }

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

    setMessages((prev) => [
      ...prev,
      { role: "assistant", events },
    ]);
    setLiveEvents([]);
    setIsRunning(false);
    refetchState();
  }, [input, isRunning, refetchState]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row gap-4 p-4 max-w-7xl mx-auto">
      {/* Sidebar */}
      <div className="lg:w-72 shrink-0">
        <div className="text-xs text-muted-foreground tracking-[0.3em] mb-3 glow-green">
          VON NEUMANN PROBE
        </div>
        <ProbePanel state={state} />
        <div className="mt-3 text-xs text-muted-foreground text-center tracking-widest opacity-50">
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
                  <div className="flex-1">
                    <AssistantBubble events={msg.events} />
                  </div>
                </div>
              )}
            </div>
          ))}

          {isRunning && liveEvents.length > 0 && (
            <div className="flex gap-2 items-start">
              <span className="text-primary text-xs shrink-0 mt-0.5 glow-green pulse-active">PROBE›</span>
              <div className="flex-1">
                <div className="space-y-1.5 border border-border rounded p-3 bg-card/60 border-glow">
                  {liveEvents
                    .filter(
                      (e) =>
                        e.type === "message" ||
                        e.type === "action" ||
                        e.type === "result" ||
                        e.type === "status" ||
                        e.type === "error"
                    )
                    .map((e, i) => (
                      <EventRow key={i} event={e} />
                    ))}
                  <div className="text-xs text-primary cursor-blink" />
                </div>
              </div>
            </div>
          )}

          {isRunning && liveEvents.length === 0 && (
            <div className="flex gap-2 items-start">
              <span className="text-primary text-xs shrink-0 mt-0.5 glow-green pulse-active">PROBE›</span>
              <div className="text-xs text-muted-foreground pulse-active">PROCESSING…</div>
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
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isRunning}
                rows={2}
                placeholder="Tell your probe what to do… (Enter to send, Shift+Enter for newline)"
                className="w-full bg-transparent text-foreground text-sm placeholder:text-muted-foreground/40 resize-none outline-none font-mono"
              />
            </div>
            <button
              onClick={sendCommand}
              disabled={isRunning || !input.trim()}
              className="shrink-0 px-4 py-2 text-xs tracking-widest font-bold border rounded transition-all
                border-primary text-primary hover:bg-primary hover:text-primary-foreground
                disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isRunning ? "…" : "EXECUTE"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
