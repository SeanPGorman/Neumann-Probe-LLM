import { useRef, useEffect, useState, useCallback, useMemo } from "react";

const RADIUS = 4;

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
  sectorsData?: { sectors: any[] };
}

export function GlobeMap({ probeX, probeY, probeZ, originX, originY, originZ, isMoving, sectorsData }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotRef = useRef({ x: 0.4, y: 0.6 });
  const [rot, setRot] = useState({ x: 0.4, y: 0.6 });
  const [selected, setSelected] = useState<{ ax: number; ay: number; az: number } | null>(null);
  const dragRef = useRef<{ mx: number; my: number; rx: number; ry: number } | null>(null);
  const dotsRef = useRef<ProjectedDot[]>([]);
  const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0];
  const zoomRef = useRef(1.0);
  const [zoom, setZoom] = useState(1.0);

  const zoomIn = useCallback(() => {
    const next = ZOOM_LEVELS.find(z => z > zoomRef.current) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    zoomRef.current = next;
    setZoom(next);
  }, []);
  const zoomOut = useCallback(() => {
    const prev = [...ZOOM_LEVELS].reverse().find(z => z < zoomRef.current) ?? ZOOM_LEVELS[0];
    zoomRef.current = prev;
    setZoom(prev);
  }, []);

  // Brightness controls (0–1) for each visual element
  const [brightProbe,   setBrightProbe]   = useState(1.0);
  const [brightDots,    setBrightDots]    = useState(1.0);
  const [brightVisited, setBrightVisited] = useState(1.0);
  const [brightCourse,  setBrightCourse]  = useState(1.0);

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

    // getBoundingClientRect gives exact sub-pixel CSS size → crisp buffer
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
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

    // Back-to-front sort; store for click-hit testing
    pts.sort((a, b) => b.z2 - a.z2);

    // Helper: project any absolute sector coordinate.
    // Clamp denominator so far/behind-camera sectors stay on-screen.
    const project = (ax: number, ay: number, az: number) => {
      const dx = ax - probeX, dy = ay - probeY, dz = az - probeZ;
      const x1 = dx * cosY + dz * sinY;
      const y1 = dy;
      const z1 = -dx * sinY + dz * cosY;
      const x2 = x1;
      const y2 = y1 * cosX - z1 * sinX;
      const z2 = y1 * sinX + z1 * cosX;
      // Clamp: never let denom go below camDist*0.7 → persp stays reasonable
      const denom = Math.max(camDist + z2, camDist * 0.7);
      const persp = fov / denom;
      return { sx: cx + x2 * persp, sy: cy + y2 * persp, z2, persp };
    };

    // Faint sphere outline
    const sphereScreenR = fov / camDist * RADIUS * 0.97;
    ctx.beginPath();
    ctx.arc(cx, cy, sphereScreenR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(80,255,130,0.05)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 1. Sparse uncharted lattice dots (skip probe & visited — drawn separately)
    for (const p of pts) {
      const { sx, sy, ax, ay, az, z2 } = p;
      if (visitedMap.has(`${ax},${ay},${az}`)) continue;
      if (ax === probeX && ay === probeY && az === probeZ) continue;
      const depth = (z2 + RADIUS) / (2 * RADIUS);
      ctx.beginPath();
      ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(80,160,255,${(0.12 + depth * 0.22) * brightDots})`;
      ctx.fill();
    }

    // 2. Compute visited projections (chronological) — used for both dots and path
    const visitedSorted = Array.from(visitedMap.values()).sort(
      (a, b) => new Date(a.firstVisitedAt ?? a.lastVisitedAt).getTime()
             - new Date(b.firstVisitedAt ?? b.lastVisitedAt).getTime()
    );
    const visitedProj = visitedSorted.map(vs => ({
      ...project(vs.sectorX, vs.sectorY, vs.sectorZ),
      vs,
    }));

    // Expose all dots to dotsRef for click-hit testing
    const allDots: ProjectedDot[] = [
      ...pts,
      ...visitedProj
        .filter(vp => !pts.some(p => p.ax === vp.vs.sectorX && p.ay === vp.vs.sectorY && p.az === vp.vs.sectorZ))
        .map(vp => ({
          sx: vp.sx, sy: vp.sy,
          ax: vp.vs.sectorX, ay: vp.vs.sectorY, az: vp.vs.sectorZ,
          dx: vp.vs.sectorX - probeX, dy: vp.vs.sectorY - probeY, dz: vp.vs.sectorZ - probeZ,
          z2: vp.z2,
        })),
    ];
    dotsRef.current = allDots;

    // 3. Visited sector dots (small, so path line is visible on top)
    for (const vp of visitedProj) {
      const { sx, sy, vs } = vp;
      const isProbePos = vs.sectorX === probeX && vs.sectorY === probeY && vs.sectorZ === probeZ;
      const isOriginPos = isMoving && vs.sectorX === originX && vs.sectorY === originY && vs.sectorZ === originZ;
      const isSelected = selected?.ax === vs.sectorX && selected?.ay === vs.sectorY && selected?.az === vs.sectorZ;
      if (isProbePos) continue;

      const r = 3.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      const va = brightVisited;
      ctx.fillStyle = isOriginPos ? `rgba(255,210,80,${va})` : isSelected ? `rgba(255,250,130,${va})` : `rgba(255,140,0,${0.95 * va})`;
      ctx.fill();

      if (isSelected || isOriginPos) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = isOriginPos ? "rgba(255,200,80,0.7)" : "rgba(255,240,120,0.9)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 4. Path line drawn AFTER dots so it's visible on top of them
    if (visitedProj.length > 1) {
      ctx.beginPath();
      ctx.moveTo(visitedProj[0].sx, visitedProj[0].sy);
      for (let i = 1; i < visitedProj.length; i++) {
        ctx.lineTo(visitedProj[i].sx, visitedProj[i].sy);
      }
      ctx.strokeStyle = `rgba(0,220,80,${brightCourse})`;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // 5. Probe dot — always on top
    const probePrj = project(probeX, probeY, probeZ);
    {
      const { sx, sy, persp } = probePrj;
      const r = Math.max(2, persp * 0.32);
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100,255,150,${0.04 * brightProbe})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,255,200,${0.65 * brightProbe})`;
      ctx.fill();
    }

    // Legend
    ctx.font = "9px monospace";
    const legends: [string, string][] = [
      ["◉ probe", "rgba(200,255,220,0.9)"],
      ...(isMoving ? [["○ origin", "rgba(255,200,80,0.7)"] as [string, string]] : []),
      ["● visited", "rgba(60,220,110,0.8)"],
    ];
    legends.forEach(([label, color], i) => {
      ctx.fillStyle = color;
      ctx.fillText(label, 6, H - 6 - i * 12);
    });
  }, [rot, zoom, probeX, probeY, probeZ, originX, originY, originZ, isMoving, visitedMap, selected,
      brightProbe, brightDots, brightVisited, brightCourse]);

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
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground tracking-widest">SECTOR GLOBE</div>
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= 0.25}
            className="text-[11px] font-mono w-5 h-5 flex items-center justify-center rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-25 disabled:cursor-not-allowed"
          >−</button>
          <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-center">{zoom}×</span>
          <button
            onClick={zoomIn}
            disabled={zoom >= 5.0}
            className="text-[11px] font-mono w-5 h-5 flex items-center justify-center rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-25 disabled:cursor-not-allowed"
          >+</button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground/40">
        Drag to rotate · scroll to zoom · click dot to inspect · {visitedMap.size} visited
      </div>

      {/* Brightness sliders */}
      <div className="flex flex-col gap-1 px-0.5">
        {(
          [
            ["PROBE",   brightProbe,   setBrightProbe],
            ["DOTS",    brightDots,    setBrightDots],
            ["VISITED", brightVisited, setBrightVisited],
            ["COURSE",  brightCourse,  setBrightCourse],
          ] as [string, number, (v: number) => void][]
        ).map(([label, val, set]) => (
          <div key={label} className="flex items-center gap-1.5 min-w-0">
            <span className="text-[9px] font-mono text-muted-foreground/50 w-12 shrink-0">{label}</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={val}
              onChange={e => set(parseFloat(e.target.value))}
              className="flex-1 h-1 accent-green-400 cursor-pointer"
            />
          </div>
        ))}
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
