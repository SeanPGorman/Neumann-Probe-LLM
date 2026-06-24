import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api-server";
const RADIUS = 6;

// Pre-generate all valid coordinate offsets within RADIUS
// Valid = even sum, within sphere
const OFFSETS: [number, number, number][] = (() => {
  const pts: [number, number, number][] = [];
  const r2 = RADIUS * RADIUS;
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        if (dx * dx + dy * dy + dz * dz <= r2 && (dx + dy + dz) % 2 === 0)
          pts.push([dx, dy, dz]);
      }
    }
  }
  return pts;
})();

interface VisitedSector {
  sectorX: number;
  sectorY: number;
  sectorZ: number;
  lastVisitedAt: string;
  firstVisitedAt: string;
  visitCount: number;
  objects: any[];
  resourceSummary: string[];
}

interface ProjectedDot {
  sx: number;
  sy: number;
  ax: number;
  ay: number;
  az: number;
  dx: number;
  dy: number;
  dz: number;
  z2: number;
}

interface Props {
  probeX: number;
  probeY: number;
  probeZ: number;
  originX?: number;
  originY?: number;
  originZ?: number;
  isMoving: boolean;
}

export function GlobeMap({ probeX, probeY, probeZ, originX, originY, originZ, isMoving }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotRef = useRef({ x: 0.4, y: 0.6 });
  const [rot, setRot] = useState({ x: 0.4, y: 0.6 });
  const [selected, setSelected] = useState<{ ax: number; ay: number; az: number } | null>(null);
  const dragRef = useRef<{ mx: number; my: number; rx: number; ry: number } | null>(null);
  const dotsRef = useRef<ProjectedDot[]>([]);
  const zoomRef = useRef(1.0);
  const [zoom, setZoom] = useState(1.0);

  const { data: sectorsData } = useQuery({
    queryKey: ["sectors-globe"],
    queryFn: () => fetch(`${BASE}/api/vng/log/sectors`).then(r => r.json()),
    refetchInterval: 60_000,
  });

  const visitedMap = useMemo<Map<string, VisitedSector>>(() => {
    const m = new Map<string, VisitedSector>();
    for (const s of sectorsData?.sectors ?? []) {
      m.set(`${s.sectorX},${s.sectorY},${s.sectorZ}`, s);
    }
    return m;
  }, [sectorsData]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;

    // Self-resize buffer to match physical resolution; skip if not laid out yet
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (!W || !H) return;
    const bW = Math.round(W * dpr), bH = Math.round(H * dpr);
    if (canvas.width !== bW || canvas.height !== bH) {
      canvas.width = bW;
      canvas.height = bH;
    }

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel space
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const { x: rx, y: ry } = rotRef.current;

    const cosY = Math.cos(ry), sinY = Math.sin(ry);
    const cosX = Math.cos(rx), sinX = Math.sin(rx);
    const camDist = RADIUS * 1.7;
    const fov = Math.min(W, H) * 0.42 * zoomRef.current;

    const pts: ProjectedDot[] = OFFSETS.map(([dx, dy, dz]) => {
      // Rotate Y then X
      const x1 = dx * cosY + dz * sinY;
      const y1 = dy;
      const z1 = -dx * sinY + dz * cosY;
      const x2 = x1;
      const y2 = y1 * cosX - z1 * sinX;
      const z2 = y1 * sinX + z1 * cosX;
      const persp = fov / (camDist + z2);
      return {
        sx: cx + x2 * persp,
        sy: cy + y2 * persp,
        ax: probeX + dx,
        ay: probeY + dy,
        az: probeZ + dz,
        dx, dy, dz, z2,
      };
    });

    // Back-to-front sort
    pts.sort((a, b) => b.z2 - a.z2);
    dotsRef.current = pts;

    // Faint sphere outline
    const sphereScreenR = fov / camDist * RADIUS * 0.97;
    ctx.beginPath();
    ctx.arc(cx, cy, sphereScreenR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(80,255,130,0.04)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Axis indicators (very faint)
    for (const [adx, ady, adz, label, col] of [
      [RADIUS * 0.7, 0, 0, "X", "255,80,80"],
      [0, RADIUS * 0.7, 0, "Y", "80,180,255"],
      [0, 0, RADIUS * 0.7, "Z", "255,220,80"],
    ] as [number, number, number, string, string][]) {
      const x1 = adx * cosY + adz * sinY;
      const y1 = ady;
      const z1 = -adx * sinY + adz * cosY;
      const x2 = x1;
      const y2 = y1 * cosX - z1 * sinX;
      const z2 = y1 * sinX + z1 * cosX;
      const persp = fov / (camDist + z2);
      const ex = cx + x2 * persp, ey = cy + y2 * persp;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(${col},0.12)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = `rgba(${col},0.18)`;
      ctx.font = "9px monospace";
      ctx.fillText(label, ex + 2, ey - 2);
    }

    // Draw dots
    for (const p of pts) {
      const { sx, sy, ax, ay, az, dx, dy, dz, z2 } = p;
      const depth = (z2 + RADIUS) / (2 * RADIUS); // 0=back, 1=front
      const persp = fov / (camDist + z2);
      const r = Math.max(1.2, persp * 0.32);

      const isProbe = dx === 0 && dy === 0 && dz === 0;
      const isOrigin = isMoving && ax === originX && ay === originY && az === originZ;
      const isVisited = visitedMap.has(`${ax},${ay},${az}`);
      const isSelected = selected?.ax === ax && selected?.ay === ay && selected?.az === az;

      let fillColor: string;
      let alpha: number;
      let dotR = r;

      if (isProbe) {
        fillColor = "200,255,220";
        alpha = 1;
        dotR = Math.max(3, r * 1.5);
      } else if (isOrigin) {
        fillColor = "255,200,80";
        alpha = 0.85;
        dotR = Math.max(2.5, r * 1.3);
      } else if (isSelected) {
        fillColor = "255,240,120";
        alpha = 1;
        dotR = Math.max(2.5, r * 1.3);
      } else if (isVisited) {
        fillColor = "60,220,110";
        alpha = 0.35 + depth * 0.6;
        dotR = Math.max(2, r * 1.1);
      } else {
        fillColor = "80,160,255";
        alpha = 0.03 + depth * 0.12;
      }

      ctx.beginPath();
      ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${fillColor},${alpha})`;
      ctx.fill();

      if (isProbe) {
        ctx.beginPath();
        ctx.arc(sx, sy, dotR * 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(100,255,150,0.08)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, dotR * 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(180,255,200,0.15)";
        ctx.fill();
      }

      if (isSelected || isOrigin) {
        ctx.beginPath();
        ctx.arc(sx, sy, dotR + 3, 0, Math.PI * 2);
        ctx.strokeStyle = isOrigin
          ? `rgba(255,200,80,${0.5 + depth * 0.4})`
          : `rgba(255,240,120,0.9)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Legend
    ctx.font = "9px monospace";
    const legends: [string, string][] = [
      ["◉ probe", "rgba(200,255,220,0.9)"],
      ...(isMoving ? [["○ origin", "rgba(255,200,80,0.7)"] as [string, string]] : []),
      ["● visited", "rgba(60,220,110,0.8)"],
      ["· uncharted", "rgba(80,160,255,0.5)"],
    ];
    legends.forEach(([label, color], i) => {
      ctx.fillStyle = color;
      ctx.fillText(label, 6, H - 6 - i * 12);
    });
  }, [rot, zoom, probeX, probeY, probeZ, originX, originY, originZ, isMoving, visitedMap, selected]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    draw(); // initial paint
    return () => ro.disconnect();
  }, [draw]);

  // Non-passive wheel listener for zoom (passive:false needed to preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      zoomRef.current = Math.max(0.25, Math.min(5.0, zoomRef.current * factor));
      setZoom(zoomRef.current);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  function ctx(c: HTMLCanvasElement) {
    const context = c.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    return context;
  }

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mx: e.clientX, my: e.clientY, rx: rotRef.current.x, ry: rotRef.current.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const newRy = dragRef.current.ry + (e.clientX - dragRef.current.mx) * 0.012;
    const newRx = Math.max(-1.4, Math.min(1.4,
      dragRef.current.rx + (e.clientY - dragRef.current.my) * 0.012
    ));
    rotRef.current = { x: newRx, y: newRy };
    setRot({ x: newRx, y: newRy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const moved = Math.hypot(e.clientX - dragRef.current.mx, e.clientY - dragRef.current.my);
    dragRef.current = null;
    if (moved > 6) return; // was a drag, not a click

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Find nearest dot (front-to-back = reverse of sorted order)
    const dots = [...dotsRef.current].reverse();
    let best: ProjectedDot | null = null;
    let bestD = 20;
    for (const d of dots) {
      const dist = Math.hypot(d.sx - cx, d.sy - cy);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) setSelected({ ax: best.ax, ay: best.ay, az: best.az });
    else setSelected(null);
  };

  const selSector = selected ? visitedMap.get(`${selected.ax},${selected.ay},${selected.az}`) : null;
  const selIsProbe = selected?.ax === probeX && selected?.ay === probeY && selected?.az === probeZ;
  const selIsOrigin = isMoving && selected?.ax === originX && selected?.ay === originY && selected?.az === originZ;

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="text-xs text-muted-foreground tracking-widest">SECTOR GLOBE</div>
      <div className="text-[10px] text-muted-foreground/40">
        Drag to rotate · scroll to zoom · click dot to inspect
      </div>

      <div
        className="relative rounded border border-border/20 overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ height: 260, cursor: "crosshair" }}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
      </div>

      {isMoving && (
        <div className="text-[10px] text-yellow-400/70 font-mono px-1">
          ○ origin [{originX},{originY},{originZ}] → ◉ target [{probeX},{probeY},{probeZ}]
        </div>
      )}

      {selected ? (
        <div className="border border-border/50 rounded p-2 space-y-1.5 bg-background/60 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-foreground glow-green">
              [{selected.ax},{selected.ay},{selected.az}]
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {selIsProbe && <span className="text-[10px] text-primary font-bold">◉ PROBE</span>}
              {selIsOrigin && <span className="text-[10px] text-yellow-400">○ ORIGIN</span>}
              {selSector && (
                <span className="text-[10px] text-green-400">
                  VISITED ×{selSector.visitCount}
                </span>
              )}
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-muted-foreground/30 hover:text-muted-foreground ml-auto text-[10px]"
            >✕</button>
          </div>

          {selSector ? (
            <SectorDetail sector={selSector} />
          ) : (
            <div className="text-[10px] text-muted-foreground/40 italic">
              Uncharted — use SCOUT tab to scan remotely.
            </div>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground/25 text-center italic pt-1">
          Click a dot to inspect sector
        </div>
      )}
    </div>
  );
}

function SectorDetail({ sector }: { sector: VisitedSector }) {
  const stars = sector.objects?.filter((o: any) => o.type === "star") ?? [];
  const planets: any[] = [];
  const asteroids: any[] = [];
  const solarSystems: any[] = [];

  for (const o of sector.objects ?? []) {
    if (o.type === "planet") planets.push(o);
    else if (o.type === "asteroid") asteroids.push(o);
    else if (o.type === "solar_system") {
      solarSystems.push(o);
      for (const b of o.bodies ?? []) {
        if (b.type === "planet") planets.push(b);
        else if (b.type === "asteroid") asteroids.push(b);
      }
    }
  }

  const dangerLevels = sector.objects
    ?.map((o: any) => o.dangerLevel)
    .filter(Boolean) ?? [];
  const danger = dangerLevels[0] ?? null;

  return (
    <div className="space-y-1 text-[10px]">
      <div className="text-muted-foreground/50">
        Last visited {new Date(sector.lastVisitedAt).toLocaleString()}
      </div>

      {danger && (
        <div className={`font-mono ${danger === "high" ? "text-red-400" : danger === "medium" ? "text-yellow-400" : "text-green-400/60"}`}>
          danger: {danger}
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground/60">
        {solarSystems.map((s: any, i: number) => (
          <span key={i}>⊙ {s.name ?? "Solar System"}</span>
        ))}
        {stars.length > 0 && <span>★ {stars.length} star{stars.length !== 1 ? "s" : ""}</span>}
        {planets.length > 0 && <span>○ {planets.length} planet{planets.length !== 1 ? "s" : ""}</span>}
        {asteroids.length > 0 && <span>◆ {asteroids.length} asteroid{asteroids.length !== 1 ? "s" : ""}</span>}
      </div>

      {planets.length > 0 && (
        <div className="space-y-0.5 pl-1">
          {planets.slice(0, 4).map((p: any, i: number) => (
            <div key={i} className="flex gap-1.5 text-muted-foreground/50">
              <span>○</span>
              <span>{p.category ?? "planet"}</span>
              {p.habitabilityScore != null && (
                <span className={p.habitabilityScore > 0.4 ? "text-green-400/60" : ""}>
                  hab {(p.habitabilityScore * 100).toFixed(0)}%
                </span>
              )}
            </div>
          ))}
          {planets.length > 4 && (
            <div className="text-muted-foreground/30 pl-3">+{planets.length - 4} more</div>
          )}
        </div>
      )}

      {sector.resourceSummary?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sector.resourceSummary.map((r: string) => (
            <span key={r} className="px-1 py-0.5 bg-primary/10 text-primary/70 rounded">
              {r}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
