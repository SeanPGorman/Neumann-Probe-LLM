import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { SectorObject, objectIcon } from "../components/SectorObject";

// SYSTEM view: a synthetic orbital-schematic map of the probe's current sector.
//
// IMPORTANT: the game API exposes object membership + metadata but ZERO
// positional data (no coordinates, orbits, or distances within a sector). Every
// position drawn here is SYNTHESIZED for legibility — deterministically, from a
// hash of each object's stable id so the layout never jitters between refetches
// — and is explicitly NOT to scale. See the persistent caption in the render.

// --- deterministic hashing (stable id -> position) ---
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function frac(s: string): number {
  return (hash32(s) % 100000) / 100000;
}

const PLANET_COLORS: Record<string, [number, number, number]> = {
  rocky: [150, 140, 120],
  terrestrial: [90, 200, 120],
  gas_giant: [210, 160, 90],
  ice_giant: [120, 180, 230],
  lava: [230, 110, 70],
  frozen: [170, 210, 230],
  ocean: [80, 160, 220],
  desert: [210, 180, 110],
  jungle: [100, 190, 90],
  dwarf: [150, 150, 150],
};
function planetColor(cat: string | null | undefined): [number, number, number] {
  return (cat && PLANET_COLORS[cat]) || [150, 160, 170];
}

// --- marker silhouettes: round bodies (star, planet) stay circular; every
// other object class gets a distinct shape so the classes read apart at a
// glance without needing a label. ---
function tracePolygon(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number, sides: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const x = sx + Math.cos(a) * r, y = sy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
type LooseShape = "square" | "triangle" | "ring";
function looseShape(type: string | null | undefined): LooseShape {
  switch (type) {
    case "black_hole": return "ring";
    case "dust_cloud": return "triangle";
    default: return "square"; // refuel station, dormant construct, drifting item, unknowns
  }
}

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0];

// Pseudo-3D tilt tuning. See SystemMap tilt plan: proj() becomes the tilted
// ground projection, lift()/depth() carry per-body elevation + sort key.
const MAX_TILT = Math.PI / 3; // clamp so cosT never collapses rings to a line
const K_LIFT = 2.5; // elevation-per-radius-px, scaled by sinT (0 at tilt=0)
const TILT_SENS = MAX_TILT / 220; // px of drag -> radians
const DIM = 0.4; // max depth-dimming fraction at full tilt, farthest body
const PROBE_MARKER_R = 6; // self-probe marker radius; mannies anchor their lift to it
const toDeg = (rad: number) => Math.round((rad * 180) / Math.PI);

interface Node {
  key: string;
  obj: any;
  wx: number;
  wy: number;
  r: number; // screen-space radius (px), constant across zoom
  kind: "star" | "planet" | "asteroid" | "loose" | "probe" | "ghost";
  color: [number, number, number];
}

interface Props {
  probe?: any;
  sectorObjects?: any[];
  otherProbes?: any[];
  mannies?: any[];
  isMoving?: boolean;
  sectorUnavailable?: boolean;
  onScoutRequest?: (x: number, y: number, z: number) => void;
}

const MANNY_COLOR: [number, number, number] = [90, 255, 190];
const PROBE_COLOR: [number, number, number] = [120, 230, 255];
// A travelling manny moves once across its leg over a fixed travel time. We use
// the game's own miningTravelSeconds when present (the real per-leg duration);
// this fallback covers tasks that don't report one. Position = time elapsed
// since we first OBSERVED this leg ÷ travel time — a best-effort visual seeded
// at observation, not synced to the game's true task elapsed
// (taskProgressPercent / taskEstimatedEndTime); it restarts from the leg origin
// on reload.
const DEFAULT_TRAVEL_S = 600;

type MannyKind = "outbound" | "inbound" | "atTarget" | "atProbe";

// Classify a manny's truthful travel direction from its phase / task. Outbound
// = probe→target, inbound = target→probe, atTarget = working the body,
// atProbe = onboard / crafting / idle at the probe.
function mannyKind(m: any): MannyKind {
  const phase = String(m.taskPhase ?? "").toLowerCase();
  const task = String(m.currentTask ?? "").toLowerCase();
  // Phase is the authoritative travel state. The inbound test uses
  // startsWith("in"), not includes("in"), so "mining" (which merely CONTAINS
  // "in") can't be misread as inbound — keep it startsWith.
  if (phase) {
    if (phase.startsWith("min") || phase.includes("extract")) return "atTarget";
    if (phase.startsWith("out")) return "outbound";
    if (phase.startsWith("return") || phase.startsWith("in")) return "inbound";
    if (phase.includes("deposit")) return "atProbe";
    if (phase.includes("wait")) return "atTarget";
  }
  if (task === "returning") return "inbound";
  // Tasks a manny performs AT a body (so it's drawn at its target, not the
  // probe). These payload fields are undocumented-but-observed in live data.
  if (
    task === "mining" ||
    task === "salvage" ||
    task === "inspecting_sector_object" ||
    task === "inspecting_asteroid" ||
    task === "installing_waypoint_bookmark" ||
    task === "refilling_deuterium_tank" ||
    task === "turning_on_scut_relay"
  )
    return "atTarget";
  return "atProbe";
}

// Objects that live in the side rail (bookkeeping / user-created, no natural
// orbital position) rather than on the orbital canvas.
const RAIL_TYPES = new Set(["detached_container", "scut_relay"]);

export function SystemMap({ probe, sectorObjects, otherProbes, mannies, isMoving, sectorUnavailable, onScoutRequest }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  // When we first observed each manny in its current (phase, tripIndex): the
  // time origin for its single traverse (see the outbound/inbound branch in
  // draw). Observation-relative, so it doesn't claim the manny's exact real
  // position; per-manny spread on a leg is done separately via `lane`.
  const phaseSeenRef = useRef<Record<string, { phase: string; trip: any; at: number }>>({});
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1.0);
  const [zoom, setZoom] = useState(1.0);
  // Tilt: draw() reads tiltRef (like panRef/zoomRef). `tilt` state is a
  // readout-only mirror — it must NEVER enter draw's dependency array, or the
  // manny RAF effect (which depends on draw) re-subscribes every tilt frame.
  const tiltRef = useRef(0); // radians, 0..MAX_TILT
  const lastTiltDegRef = useRef(0); // last whole-degree pushed to `tilt` state (render throttle)
  const [tilt, setTilt] = useState(0);
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number; mode: "pan" | "tilt"; t0: number } | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showLabels, setShowLabels] = useState(true);

  // Escape closes the expanded (fullscreen) view. Declared before any early
  // return so the hook order stays stable regardless of transit/empty state.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { dragRef.current = null; setExpanded(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const sector = probe?.sector ?? null;
  const probeId = probe?.id ?? null;

  // Ownership for user-created objects: mine | other | unknown.
  const ownership = useCallback(
    (creatorId: any): "mine" | "other" | "unknown" => {
      if (creatorId == null) return "unknown";
      if (probeId != null && creatorId === probeId) return "mine";
      return "other";
    },
    [probeId]
  );

  // --- build the deterministic layout model from props (pure) ---
  const model = useMemo(() => {
    const objs = sectorObjects ?? [];
    const system = objs.find((o) => o.type === "solar_system") ?? null;

    // Merge solar_system bodies with any top-level bodies of the same kind.
    const bodyPlanets: any[] = [];
    const bodyAsteroids: any[] = [];
    const bodyStars: any[] = [];
    for (const b of system?.bodies ?? []) {
      if (b.type === "planet") bodyPlanets.push(b);
      else if (b.type === "asteroid") bodyAsteroids.push(b);
      else if (b.type === "star") bodyStars.push(b);
    }

    const looseSpace: any[] = []; // on-canvas outer-arc objects
    const rail: any[] = []; // side-rail objects (containers, relays)
    for (const o of objs) {
      if (o.type === "solar_system") continue;
      if (o.type === "manny") continue; // drawn by the dedicated manny-movement layer
      if (o.type === "planet") bodyPlanets.push(o);
      else if (o.type === "asteroid") bodyAsteroids.push(o);
      else if (o.type === "star") bodyStars.push(o);
      else if (RAIL_TYPES.has(o.type)) rail.push(o);
      else looseSpace.push(o); // dust_cloud, black_hole, refuel station, construct, drifting_item, ...
    }

    // System-level beacons (player-placed) also go in the rail.
    const beacons = (system?.waypointBookmarks ?? []).map((w: any, i: number) => ({
      type: "waypoint_bookmark",
      name: w.name ?? "Beacon",
      playerId: w.playerId ?? null,
      playerName: w.playerName ?? null,
      createdAt: w.createdAt ?? null,
      id: `beacon:${w.name ?? i}`,
    }));

    // De-dupe planets/asteroids/stars by id (a body can appear both nested and
    // top-level in some payloads).
    const dedupe = (arr: any[]) => {
      const seen = new Set<string>();
      return arr.filter((b, i) => {
        const k = b.id ?? `${b.type}:${b.name}:${i}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const planets = dedupe(bodyPlanets);
    const asteroids = dedupe(bodyAsteroids);
    const stars = dedupe(bodyStars);

    // Stable sort planets by habitability desc (nulls last), tiebreak by id.
    planets.sort((a, b) => {
      const ha = a.habitabilityScore ?? -1;
      const hb = b.habitabilityScore ?? -1;
      if (hb !== ha) return hb - ha;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });

    const keyOf = (o: any, i: number) => o.id ?? `${o.type}:${o.name ?? ""}:${i}`;

    const nodes: Node[] = [];

    // Center: star(s).
    if (stars.length === 1) {
      const s = stars[0];
      const r = Math.min(12, 6 + (s.radius ?? 1) * 2);
      nodes.push({ key: keyOf(s, 0), obj: s, wx: 0, wy: 0, r, kind: "star", color: [255, 220, 120] });
    } else {
      stars.forEach((s, i) => {
        const a = frac(keyOf(s, i)) * Math.PI * 2;
        const r = Math.min(11, 6 + (s.radius ?? 1) * 2);
        nodes.push({ key: keyOf(s, i), obj: s, wx: Math.cos(a) * 10, wy: Math.sin(a) * 10, r, kind: "star", color: [255, 220, 120] });
      });
    }

    // Planet rings (one planet per concentric ring), plus ghost rings for
    // planets the API counts but does not enumerate.
    const R0 = 40;
    const dR = 26;
    const orbitRadii: number[] = [];
    planets.forEach((p, i) => {
      const radius = R0 + i * dR;
      orbitRadii.push(radius);
      const a = frac(keyOf(p, i)) * Math.PI * 2;
      const pr = Math.max(2.5, Math.min(7, 2.5 + (p.radius ?? 1) * 1.2));
      nodes.push({ key: keyOf(p, i), obj: p, wx: Math.cos(a) * radius, wy: Math.sin(a) * radius, r: pr, kind: "planet", color: planetColor(p.category) });
    });
    const planetCount = system?.planetCount ?? planets.length;
    const ghostPlanetN = Math.max(0, planetCount - planets.length);
    const ghostNodes: Node[] = [];
    const sectorKey = sector ? `${sector.x},${sector.y},${sector.z}` : "sys";
    for (let g = 0; g < ghostPlanetN; g++) {
      const ring = planets.length + g;
      const radius = R0 + ring * dR;
      orbitRadii.push(radius);
      const a = frac(`${sectorKey}#pg${g}`) * Math.PI * 2;
      ghostNodes.push({ key: `ghost-planet-${g}`, obj: null, wx: Math.cos(a) * radius, wy: Math.sin(a) * radius, r: 3, kind: "ghost", color: [140, 140, 140] });
    }

    const outerRingCount = planets.length + ghostPlanetN;
    const lastPlanetR = R0 + Math.max(0, outerRingCount - 1) * dR;

    // Asteroid belt: annulus just past the outermost planet ring.
    const beltInner = lastPlanetR + 28;
    const beltWidth = 24;
    asteroids.forEach((asrc, i) => {
      const radius = beltInner + frac(keyOf(asrc, i) + "#r") * beltWidth;
      const a = frac(keyOf(asrc, i)) * Math.PI * 2;
      nodes.push({ key: keyOf(asrc, i), obj: asrc, wx: Math.cos(a) * radius, wy: Math.sin(a) * radius, r: 2, kind: "asteroid", color: [165, 155, 140] });
    });

    // Outer arc: loose space objects + other probes.
    const outerR = beltInner + beltWidth + 32;
    looseSpace.forEach((o, i) => {
      const a = frac(keyOf(o, i)) * Math.PI * 2;
      nodes.push({ key: keyOf(o, i), obj: o, wx: Math.cos(a) * outerR, wy: Math.sin(a) * outerR, r: 3.5, kind: "loose", color: [150, 180, 200] });
    });
    (otherProbes ?? []).forEach((p, i) => {
      const key = `probe:${p.id ?? i}`;
      const a = frac(key) * Math.PI * 2;
      nodes.push({ key, obj: { ...p, type: "probe" }, wx: Math.cos(a) * outerR, wy: Math.sin(a) * outerR, r: 4, kind: "probe", color: [230, 120, 220] });
    });

    const maxWorldR = Math.max(outerR + 16, beltInner + beltWidth + 16, 60);

    // Probe position: our probe is its OWN object, not the star at the center.
    // Pick a synthetic spot that maximises the distance to the NEAREST drawn
    // body (largest minimum clearance to star, planets, asteroids, loose
    // objects, ghosts, other probes) so the marker — and the manny routes that
    // originate from it — never sit on top of another object. Deterministic
    // (seeded by sector) so it never jitters.
    const obstacles: [number, number][] = [
      [0, 0], // the star / system centre
      ...nodes.map((n) => [n.wx, n.wy] as [number, number]),
      ...ghostNodes.map((n) => [n.wx, n.wy] as [number, number]),
    ];
    const angOff = frac(`${sectorKey}#probe`) * Math.PI * 2;
    const rMin = R0 * 0.5;
    const rMax = Math.max(rMin + 1, maxWorldR * 0.82);
    let probePos = { wx: Math.cos(angOff) * rMin, wy: Math.sin(angOff) * rMin };
    let bestScore = -Infinity;
    const ASTEPS = 32, RSTEPS = 7;
    for (let ri = 0; ri <= RSTEPS; ri++) {
      const rr = rMin + ((rMax - rMin) * ri) / RSTEPS;
      for (let ai = 0; ai < ASTEPS; ai++) {
        const a = angOff + (ai / ASTEPS) * Math.PI * 2;
        const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
        let nearest = Infinity;
        for (const [ox, oy] of obstacles) {
          const d = Math.hypot(cx - ox, cy - oy);
          if (d < nearest) nearest = d;
        }
        // Reward open space; gently prefer a smaller radius so the probe stays
        // reasonably central rather than flung to the rim of an empty system.
        const score = nearest - rr * 0.08;
        if (score > bestScore) { bestScore = score; probePos = { wx: cx, wy: cy }; }
      }
    }

    return {
      systemName: system?.name ?? null,
      probePos,
      stars,
      planets,
      asteroids,
      nodes,
      ghostNodes,
      rail,
      beacons,
      orbitRadii,
      beltInner,
      beltWidth,
      maxWorldR,
      counts: {
        planetCount,
        starCount: system?.starCount ?? stars.length,
        orbitalBodyCount: system?.orbitalBodyCount ?? planets.length + asteroids.length,
        enumeratedPlanets: planets.length,
        enumeratedAsteroids: asteroids.length,
      },
      hasContent: objs.length > 0,
    };
  }, [sectorObjects, otherProbes, sector]);

  // Stamp when each manny was first seen in its current (phase, trip) so a
  // freshly-observed leg starts its traverse near the beginning.
  useEffect(() => {
    const now = Date.now();
    const seen = phaseSeenRef.current;
    const live = new Set<string>();
    for (const m of mannies ?? []) {
      const id = String(m.id);
      live.add(id);
      const phase = String(m.taskPhase ?? m.currentTask ?? "");
      const trip = m.taskTripIndex ?? null;
      const prev = seen[id];
      if (!prev || prev.phase !== phase || prev.trip !== trip) seen[id] = { phase, trip, at: now };
    }
    for (const id of Object.keys(seen)) if (!live.has(id)) delete seen[id];
  }, [mannies]);

  // Resolve each plottable manny to its target node + travel direction. Mannies
  // whose task is only visible over the SCUT network (a different system) are
  // counted but not drawn on this system's map.
  const mannyModel = useMemo(() => {
    const nodeById = new Map<string, Node>();
    for (const n of model.nodes) {
      const id = n.obj?.id;
      if (id != null) nodeById.set(String(id), n);
    }
    const plotted: { m: any; kind: MannyKind; target: Node | null; lane: number }[] = [];
    let remote = 0;
    for (const m of mannies ?? []) {
      const vis = m.taskVisibility ?? null;
      if (vis && vis !== "local") { remote++; continue; }
      const target = m.taskObjectId != null ? nodeById.get(String(m.taskObjectId)) ?? null : null;
      let kind = mannyKind(m);
      if (!target && kind !== "atProbe") kind = "atProbe"; // no body to route to → sit at the probe
      plotted.push({ m, kind, target, lane: frac(String(m.id ?? "")) });
    }
    return { plotted, remote };
  }, [mannies, model]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    if (!W || !H) return;
    const bW = Math.round(W * dpr), bH = Math.round(H * dpr);
    if (canvas.width !== bW || canvas.height !== bH) {
      canvas.width = bW;
      canvas.height = bH;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2 + panRef.current.x;
    const cy = H / 2 + panRef.current.y;
    const baseScale = (Math.min(W, H) / 2) * 0.86 / model.maxWorldR;
    const scale = baseScale * zoomRef.current;

    // Tilt: proj() is redefined to be the tilted GROUND projection (same
    // {sx,sy} shape every call site already uses, so it's a drop-in). Bodies
    // are elevated above the ground point by lift(); depth() is the
    // back-to-front sort key. At tilt=0, sinT===0 exactly => proj.sy ===
    // today's cy+wy*scale, lift===0, depth===0 for every node — byte-identical
    // to the pre-tilt view (see plan's regression gate).
    const tiltNow = tiltRef.current;
    const cosT = Math.cos(tiltNow), sinT = Math.sin(tiltNow);
    const proj = (wx: number, wy: number) => ({ sx: cx + wx * scale, sy: cy + wy * cosT * scale });
    // Screen-px elevation. Star is pinned to lift=0 — it sits at the shared
    // ring center (world origin), so lifting it would float it off its own
    // rings with no ring to anchor a shadow to.
    const liftR = (r: number) => K_LIFT * r * sinT; // screen-px elevation for a radius-r thing on the plane
    const lift = (n: Node) => (n.kind === "star" ? 0 : liftR(n.r));
    // Back-to-front sort key = in-plane depth only (far/top = -wy, drawn first).
    // The elevation term is deliberately EXCLUDED: lift is a fixed screen-px
    // amount while wy*scale shrinks with zoom, so mixing them inverts occlusion
    // at low zoom (a small far body drawing in front of a large near one). At
    // tilt=0, sinT=0 => depth=0 for every node, so order() alone reproduces the
    // flat layering (regression gate).
    const depth = (n: Node) => -n.wy * scale * sinT;

    // Pseudo-3D depth mark: a soft ground shadow + a faint stalk from the
    // elevated marker (my) back down to its ground point (sx,sy). Gated on
    // sinT so it's invisible at tilt=0. Alpha strings depend only on sinT, so
    // they're built once per frame here rather than per marker.
    const shadowFill = `rgba(0,0,0,${(0.25 * sinT).toFixed(3)})`;
    const stalkStroke = `rgba(255,255,255,${(0.12 * sinT).toFixed(3)})`;
    const drawGroundShadow = (sx: number, sy: number, my: number, r: number) => {
      if (sinT <= 0.001) return;
      ctx.beginPath();
      ctx.ellipse(sx, sy, r * 0.9, r * 0.9 * cosT, 0, 0, Math.PI * 2);
      ctx.fillStyle = shadowFill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx, my);
      ctx.strokeStyle = stalkStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    // Faint orbit rings. An origin-centered circle under this oblique
    // projection is exactly an origin-centered ellipse with minor axis
    // R*scale*cosT (cx,cy already carry pan+zoom).
    ctx.lineWidth = 1;
    for (const radius of model.orbitRadii) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * scale, radius * scale * cosT, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(80,255,130,0.06)";
      ctx.stroke();
    }
    // Belt annulus outline.
    if (model.asteroids.length > 0) {
      for (const rr of [model.beltInner, model.beltInner + model.beltWidth]) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rr * scale, rr * scale * cosT, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(180,160,120,0.06)";
        ctx.stroke();
      }
    }
    // Faint ground-grid spokes — low-priority polish, only visible once
    // tilted (the elliptical rings already read as a polar grid on their own).
    if (sinT > 0.001) {
      const spokes = 12;
      ctx.strokeStyle = `rgba(120,200,255,${(0.05 * sinT).toFixed(3)})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        const edge = proj(Math.cos(a) * model.maxWorldR, Math.sin(a) * model.maxWorldR);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(edge.sx, edge.sy);
        ctx.stroke();
      }
    }

    const hit: Node[] = [];
    const selKey = selected ? (selected.id ?? `${selected.type}:${selected.name}`) : null;

    // Ghost planets (hollow/dashed).
    for (const n of model.ghostNodes) {
      const { sx, sy } = proj(n.wx, n.wy);
      ctx.beginPath();
      ctx.arc(sx, sy, n.r, 0, Math.PI * 2);
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "rgba(150,150,150,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw nodes (belt asteroids first, then planets/loose/probes, star last-ish).
    const drawNode = (n: Node) => {
      const { sx, sy } = proj(n.wx, n.wy); // ground point
      const my = sy - lift(n); // elevated marker point

      // Ground shadow + stalk, drawn first (behind the marker). Draw-only —
      // never pushed to `hit`, so clicks always select the marker, not its
      // shadow.
      drawGroundShadow(sx, sy, my, n.r);

      const [r, g, b] = n.color;
      // Depth-keyed dimming: bodies further toward the back of the tilted
      // plane read fainter. depthT is 0..1 from n.wy (back = 1), matching the
      // depth() sort direction. No-op at tilt=0 (sinT===0 => dimAlpha===1),
      // so this can't touch the regression gate.
      const depthT = Math.max(0, Math.min(1, (model.maxWorldR - n.wy) / (2 * model.maxWorldR)));
      // Star (the frontmost anchor at world origin) is exempt from depth-dimming
      // — same as its lift exemption — so a single-star sector never dims it.
      const dimAlpha = n.kind === "star" ? 1 : 1 - DIM * sinT * depthT;
      const fill = `rgba(${r},${g},${b},${(0.95 * dimAlpha).toFixed(3)})`;
      const isSel = selKey != null && (n.obj?.id ?? `${n.obj?.type}:${n.obj?.name}`) === selKey;

      // Star glow halo. Exempt from depth-dimming (pointless on the frontmost
      // anchor body) and drawn at the elevated point (always === ground point
      // for the star, since lift(star)===0).
      if (n.kind === "star") {
        ctx.beginPath();
        ctx.arc(sx, my, n.r * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},0.10)`;
        ctx.fill();
      }

      // Marker silhouette by class.
      if (n.kind === "star" || n.kind === "planet") {
        ctx.beginPath();
        ctx.arc(sx, my, n.r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
      } else if (n.kind === "probe") {
        tracePolygon(ctx, sx, my, n.r, 4, 0); // diamond
        ctx.fillStyle = fill;
        ctx.fill();
      } else if (n.kind === "asteroid") {
        // Belt dots are tiny; floor the size so the hexagon reads as a shape.
        tracePolygon(ctx, sx, my, Math.max(n.r, 3), 6, -Math.PI / 2); // hexagon
        ctx.fillStyle = fill;
        ctx.fill();
      } else if (n.kind === "loose") {
        const shp = looseShape(n.obj?.type);
        if (shp === "ring") {
          ctx.beginPath();
          ctx.arc(sx, my, n.r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(10,10,16,0.95)";
          ctx.fill();
          ctx.beginPath();
          ctx.arc(sx, my, n.r, 0, Math.PI * 2);
          ctx.strokeStyle = fill;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else if (shp === "triangle") {
          tracePolygon(ctx, sx, my, n.r + 0.5, 3, -Math.PI / 2);
          ctx.fillStyle = fill;
          ctx.fill();
        } else {
          tracePolygon(ctx, sx, my, n.r, 4, Math.PI / 4); // square
          ctx.fillStyle = fill;
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ctx.arc(sx, my, n.r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
      }

      // Intelligent-life ring on planets.
      if (n.kind === "planet" && n.obj?.intelligentLife) {
        ctx.beginPath();
        ctx.arc(sx, my, n.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,230,90,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(sx, my, n.r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,250,130,0.95)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Object name label (toggleable). Skip belt asteroids unless the belt is
      // small, so a dense belt doesn't turn into an unreadable wall of text.
      // Exempt from depth-dimming — dimmed far labels become unreadable.
      if (showLabels && (n.kind !== "asteroid" || model.asteroids.length <= 10)) {
        const raw = n.obj?.name ?? n.obj?.category ?? n.obj?.type ?? "";
        let label = String(raw).replace(/_/g, " ");
        if (label.length > 16) label = label.slice(0, 15) + "…";
        if (label) {
          const tx = sx + n.r + 3, ty = my + 3;
          ctx.font = "8px monospace";
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "rgba(0,0,0,0.55)";
          ctx.strokeText(label, tx, ty);
          ctx.fillStyle = "rgba(200,220,210,0.7)";
          ctx.fillText(label, tx, ty);
        }
      }

      hit.push({ ...n, wx: sx, wy: my }); // store screen coords for hit-test
    };

    const order = (k: Node["kind"]) => ({ asteroid: 0, planet: 1, loose: 2, probe: 3, star: 4, ghost: 5 }[k]);
    // Back-to-front depth sort; the kind tiebreak is mandatory — at tilt=0
    // depth() is 0 for every node, so the tiebreak alone reproduces today's
    // flat layering (regression gate).
    [...model.nodes].sort((a, b) => depth(b) - depth(a) || order(a.kind) - order(b.kind)).forEach(drawNode);

    // --- Manny movement layer (drawn on top of bodies) ---
    // Mannies launch from and return to the PROBE (its own off-centre marker),
    // not the star at the system centre.
    const now = Date.now();
    const PX = model.probePos.wx, PY = model.probePos.wy;
    const routeDrawn = new Set<string>();
    const probeLift = liftR(PROBE_MARKER_R); // shared by route ends, mannies, and the self-probe marker
    for (const pm of mannyModel.plotted) {
      const { m, kind, target, lane } = pm;
      const seenAt = phaseSeenRef.current[String(m.id)]?.at ?? now;

      // Faint route line (once per target) for mannies travelling to / at a body.
      if (target && kind !== "atProbe") {
        const rk = String(target.obj?.id ?? target.key);
        if (!routeDrawn.has(rk)) {
          routeDrawn.add(rk);
          const a = proj(PX, PY), b = proj(target.wx, target.wy);
          // Meet the ELEVATED probe & body markers, not their ground points, so
          // the route doesn't visibly stop short under tilt.
          const aLift = probeLift, bLift = lift(target);
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.lineDashOffset = (kind === "inbound" ? 1 : -1) * ((now / 50) % 7);
          ctx.strokeStyle = "rgba(90,255,190,0.16)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy - aLift);
          ctx.lineTo(b.sx, b.sy - bLift);
          ctx.stroke();
          ctx.restore();
        }
      }

      // World position by travel direction (probe ⇄ target). `elev` tracks the
      // plane elevation at the manny's anchor so it rides WITH the tilted bodies
      // (the probe marker and the target body are both lifted); a traveller
      // interpolates between the two so it rises/settles across the leg.
      let wx = PX, wy = PY, alpha = 0.95, pulse = 0, elev = 0;
      if (kind === "atProbe") {
        const ang = lane * Math.PI * 2;
        wx = PX + Math.cos(ang) * 12; wy = PY + Math.sin(ang) * 12;
        pulse = 0.5 + 0.5 * Math.sin(now / 500 + lane * 6);
        elev = probeLift;
      } else if (kind === "atTarget" && target) {
        const ang = lane * Math.PI * 2 + now / 3000;
        wx = target.wx + Math.cos(ang) * 9; wy = target.wy + Math.sin(ang) * 9;
        pulse = 0.5 + 0.5 * Math.sin(now / 400 + lane * 6);
        elev = lift(target);
      } else if (target) {
        // outbound / inbound: a single traverse over a fixed travel time based
        // on how long we've observed this leg. Consecutive legs share endpoints
        // (probe / asteroid), so phase transitions don't cause jumps. Once the
        // travel time elapses the manny simply waits at the destination.
        const travelMs = ((m.miningTravelSeconds ?? DEFAULT_TRAVEL_S) as number) * 1000;
        const f = Math.max(0, Math.min(1, (now - seenAt) / travelMs));
        const [ox, oy] = kind === "inbound" ? [target.wx, target.wy] : [PX, PY];
        const [dx, dy] = kind === "inbound" ? [PX, PY] : [target.wx, target.wy];
        const px = ox + (dx - ox) * f, py = oy + (dy - oy) * f;
        const vx = target.wx - PX, vy = target.wy - PY;
        const len = Math.hypot(vx, vy) || 1;
        const off = (lane - 0.5) * 12;
        wx = px + (-vy / len) * off; wy = py + (vx / len) * off;
        const tgtLift = lift(target);
        const [oLift, dLift] = kind === "inbound" ? [tgtLift, probeLift] : [probeLift, tgtLift];
        elev = oLift + (dLift - oLift) * f;
      }

      const { sx, sy } = proj(wx, wy);
      const my = sy - elev; // elevated to the plane, like the bodies it travels between
      const [mr, mg, mb] = MANNY_COLOR;
      const rad = 3.2 + pulse * 1.1;
      const isSel = selected?.type === "manny" && String(selected.id) === String(m.id);

      ctx.beginPath();
      ctx.arc(sx, my, rad, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${mr},${mg},${mb},${alpha.toFixed(3)})`;
      ctx.fill();
      if (kind === "atTarget" && m.taskProgressPercent != null) {
        ctx.beginPath();
        ctx.arc(sx, my, rad + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (m.taskProgressPercent / 100));
        ctx.strokeStyle = `rgba(${mr},${mg},${mb},0.8)`;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(sx, my, rad + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,250,130,0.95)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      hit.push({ key: `manny:${m.id}`, obj: { ...m, type: "manny" }, wx: sx, wy: my, r: Math.max(7, rad + 3), kind: "probe", color: MANNY_COLOR });
    }

    // --- Our probe: a distinct off-centre marker (drawn on top) ---
    {
      const { sx, sy } = proj(model.probePos.wx, model.probePos.wy);
      const [pr, pg, pb] = PROBE_COLOR;
      const s = PROBE_MARKER_R;
      const my = sy - probeLift; // float on the plane like the bodies
      const isSel = selected?.type === "self_probe";
      drawGroundShadow(sx, sy, my, s); // ground shadow + stalk, matching the body depth layer
      ctx.beginPath();
      ctx.arc(sx, my, s + 3, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.45)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, my - s);
      ctx.lineTo(sx + s, my);
      ctx.lineTo(sx, my + s);
      ctx.lineTo(sx - s, my);
      ctx.closePath();
      ctx.fillStyle = `rgba(${pr},${pg},${pb},0.95)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (isSel) {
        ctx.beginPath();
        ctx.arc(sx, my, s + 6, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,250,130,0.95)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (showLabels) {
        ctx.font = "9px monospace";
        ctx.fillStyle = `rgba(${pr},${pg},${pb},0.9)`;
        ctx.fillText("PROBE", sx + s + 4, my + 3);
      }
      hit.push({ key: "self_probe", obj: { ...(probe ?? {}), type: "self_probe" }, wx: sx, wy: my, r: s + 4, kind: "probe", color: PROBE_COLOR });
    }

    nodesRef.current = hit;

    // Legend (bottom-left).
    ctx.font = "9px monospace";
    const legends: [string, string][] = [
      ["⬦ your probe", "rgba(120,230,255,0.95)"],
      ["★ star", "rgba(255,220,120,0.9)"],
      ["○ planet", "rgba(150,180,150,0.9)"],
      ["⬡ asteroid", "rgba(165,155,140,0.9)"],
      ["▢ other object", "rgba(150,180,200,0.9)"],
    ];
    if (mannyModel.plotted.length) legends.push(["♦ manny", "rgba(90,255,190,0.95)"]);
    if ((otherProbes ?? []).length) legends.push(["◈ other probe", "rgba(230,120,220,0.95)"]);
    legends.forEach(([label, color], i) => {
      ctx.fillStyle = color;
      ctx.fillText(label, 6, H - 6 - i * 12);
    });
  }, [model, mannyModel, zoom, selected, otherProbes, probe, showLabels]);

  useEffect(() => { draw(); }, [draw, expanded]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    draw();
    return () => ro.disconnect();
  }, [draw]);

  // Animate the manny-movement layer. Only runs while mannies are on the map;
  // throttled to ~30fps; requestAnimationFrame pauses itself in hidden tabs.
  useEffect(() => {
    if (mannyModel.plotted.length === 0) return;
    let raf = 0, last = 0, running = true;
    const loop = (t: number) => {
      if (!running) return;
      if (t - last > 33) { last = t; draw(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, [mannyModel, draw]);

  // Non-passive wheel zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      zoomRef.current = Math.max(0.5, Math.min(5.0, zoomRef.current * factor));
      setZoom(zoomRef.current);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const zoomIn = useCallback(() => {
    const next = ZOOM_LEVELS.find((z) => z > zoomRef.current) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    zoomRef.current = next; setZoom(next);
  }, []);
  const zoomOut = useCallback(() => {
    const prev = [...ZOOM_LEVELS].reverse().find((z) => z < zoomRef.current) ?? ZOOM_LEVELS[0];
    zoomRef.current = prev; setZoom(prev);
  }, []);

  // Tilt gesture: right-mouse-drag OR Shift+left-drag tilts the plane; a
  // plain left-drag still pans. Shift+drag is the primary path (right-drag is
  // the bonus — Ctrl+drag / edge back-forward gestures make the right button
  // finicky on some platforms).
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const wantTilt = e.button === 2 || e.shiftKey;
    dragRef.current = {
      mx: e.clientX,
      my: e.clientY,
      px: panRef.current.x,
      py: panRef.current.y,
      mode: wantTilt ? "tilt" : "pan",
      t0: tiltRef.current,
    };
    (e.currentTarget as HTMLElement).style.cursor = wantTilt ? "ns-resize" : "crosshair";
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "tilt") {
      // Drag up = more tilt. draw() every move via tiltRef; but only push React
      // `tilt` state when the whole-degree readout changes, so a fast drag
      // doesn't re-render the whole component (header/rail/detail) per event.
      tiltRef.current = Math.max(0, Math.min(MAX_TILT, drag.t0 + (drag.my - e.clientY) * TILT_SENS));
      const deg = toDeg(tiltRef.current);
      if (deg !== lastTiltDegRef.current) { lastTiltDegRef.current = deg; setTilt(tiltRef.current); }
      draw();
      return;
    }
    panRef.current = {
      x: drag.px + (e.clientX - drag.mx),
      y: drag.py + (e.clientY - drag.my),
    };
    draw();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).style.cursor = "crosshair";
    // Read mode (and the button) BEFORE the selection logic: a sub-6px tilt
    // tweak or a bare right-click must never fall through to selection.
    if (drag.mode === "tilt") {
      // Sync the exact final tilt to state (moves between whole degrees were
      // throttled out above).
      setTilt(tiltRef.current);
      lastTiltDegRef.current = toDeg(tiltRef.current);
      return;
    }
    if (e.button === 2) return;

    const moved = Math.hypot(e.clientX - drag.mx, e.clientY - drag.my);
    if (moved > 6) return; // drag, not click

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    let best: Node | null = null;
    let bestD = 18;
    for (const n of [...nodesRef.current].reverse()) {
      const d = Math.hypot(n.wx - cx, n.wy - cy);
      if (d < bestD) { bestD = d; best = n; }
    }
    setSelected(best?.obj ?? null);
  };

  // A drag can be yanked away without a pointerup (touch-scroll steal, pen
  // barrel-click, OS gesture). Without this the ns-resize cursor sticks and
  // dragRef leaks stale coords into the next gesture.
  const onPointerCancel = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).style.cursor = "crosshair";
  };

  // Flatten only the tilt, keeping pan/zoom — the degree readout's own click
  // target (see `controls` below).
  const flattenTilt = useCallback(() => {
    tiltRef.current = 0;
    lastTiltDegRef.current = 0;
    setTilt(0);
    draw();
  }, [draw]);

  const resetView = useCallback(() => {
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1.0;
    setZoom(1.0);
    dragRef.current = null;
    flattenTilt(); // also zeroes tilt state and repaints
  }, [flattenTilt]);

  const counts = model.counts;
  const undetailed =
    counts.planetCount > counts.enumeratedPlanets ||
    counts.orbitalBodyCount > counts.enumeratedPlanets + counts.enumeratedAsteroids;

  // Header controls — reused by both the compact and expanded shells. The
  // expand/collapse toggle is what lets the map grow beyond the narrow sidebar
  // (the `lg:w-72` column in Commander.tsx).
  const controls = (
    <div className="flex items-center gap-1">
      <button onClick={resetView} className="text-[9px] font-mono px-1.5 h-5 rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border">reset</button>
      <button onClick={zoomOut} disabled={zoom <= 0.5} className="text-[11px] font-mono w-5 h-5 flex items-center justify-center rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-25">−</button>
      <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-center">{Number(zoom.toFixed(2))}×</span>
      <button onClick={zoomIn} disabled={zoom >= 5.0} className="text-[11px] font-mono w-5 h-5 flex items-center justify-center rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-25">+</button>
      {tilt > 0.02 && (
        <button
          onClick={flattenTilt}
          title="Flatten tilt (keeps pan/zoom)"
          className="text-[9px] font-mono px-1.5 h-5 rounded border border-primary/50 text-primary hover:border-primary"
        >
          {toDeg(tilt)}°
        </button>
      )}
      <button
        onClick={() => setShowLabels((v) => !v)}
        title={showLabels ? "Hide object labels" : "Show object labels"}
        className={`text-[9px] font-mono px-1.5 h-5 rounded border hover:border-primary/50 ${showLabels ? "border-primary/50 text-primary" : "border-border/40 text-muted-foreground hover:text-foreground"}`}
      >
        labels
      </button>
      <button
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Collapse (Esc)" : "Expand map"}
        className="text-[10px] font-mono px-1.5 h-5 flex items-center gap-1 rounded border border-border/40 text-muted-foreground hover:text-primary hover:border-primary/50"
      >
        {expanded ? "⤡ close" : "⤢ expand"}
      </button>
    </div>
  );

  // --- transit state (hooks above are already declared; safe to early-return) ---
  if (isMoving) {
    const transitCard = (
      <div className="flex flex-col h-full items-center justify-center text-center gap-2 py-10">
        <div className="text-xs text-muted-foreground tracking-widest">SYSTEM MAP</div>
        <div className="text-yellow-400/80 font-mono text-sm">PROBE IN TRANSIT</div>
        <div className="text-[10px] text-muted-foreground/50 max-w-[220px]">
          System map unavailable at relativistic speed. It will populate on arrival.
        </div>
      </div>
    );
    if (!expanded) return transitCard;
    return (
      <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm p-4 flex flex-col">
        <div className="flex items-center justify-end">
          <button onClick={() => setExpanded(false)} className="text-[10px] font-mono px-1.5 h-5 rounded border border-border/40 text-muted-foreground hover:text-primary hover:border-primary/50">⤡ close</button>
        </div>
        <div className="flex-1 flex items-center justify-center">{transitCard}</div>
      </div>
    );
  }

  // --- sector fetch failed (and we're NOT in transit — that's handled above) ---
  // Show an honest "data unavailable" state rather than a false "empty sector":
  // the scan threw (network/API error), it is not that the sector has no objects.
  if (sectorUnavailable) {
    const unavailableCard = (
      <div className="flex flex-col h-full items-center justify-center text-center gap-2 py-10">
        <div className="text-xs text-muted-foreground tracking-widest">SYSTEM MAP</div>
        <div className="text-yellow-400/80 font-mono text-sm">SECTOR DATA UNAVAILABLE</div>
        <div className="text-[10px] text-muted-foreground/50 max-w-[240px]">
          Sector scan failed to load — a fetch error, not an empty sector. It should recover on the next refresh.
        </div>
      </div>
    );
    if (!expanded) return unavailableCard;
    return (
      <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm p-4 flex flex-col">
        <div className="flex items-center justify-end">
          <button onClick={() => setExpanded(false)} className="text-[10px] font-mono px-1.5 h-5 rounded border border-border/40 text-muted-foreground hover:text-primary hover:border-primary/50">⤡ close</button>
        </div>
        <div className="flex-1 flex items-center justify-center">{unavailableCard}</div>
      </div>
    );
  }

  const header = (
    <div className="flex items-center justify-between">
      <div className="text-xs text-muted-foreground tracking-widest">
        SYSTEM MAP{model.systemName ? <span className="text-primary/70 ml-1 glow-green">· {model.systemName}</span> : null}
      </div>
      {controls}
    </div>
  );

  const sectorLine = sector && (
    <div className="text-[10px] text-muted-foreground/40 flex items-center justify-between">
      <span>sector [{sector.x},{sector.y},{sector.z}] · drag to pan · scroll to zoom · click to inspect · shift-drag to tilt</span>
      {onScoutRequest && (
        <button onClick={() => onScoutRequest(sector.x, sector.y, sector.z)} className="text-primary/60 hover:text-primary underline-offset-2 hover:underline">scan</button>
      )}
    </div>
  );

  const canvasBox = (
    <div
      className={`relative rounded border border-border/20 overflow-hidden ${expanded ? "flex-1 min-h-0" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      style={{ cursor: "crosshair", ...(expanded ? {} : { height: 300 }) }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
      <div className="absolute top-1 right-2 text-[8px] text-muted-foreground/40 tracking-wider pointer-events-none text-right">
        ILLUSTRATIVE LAYOUT<br />POSITIONS SYNTHETIC · NOT TO SCALE
      </div>
    </div>
  );

  const countsNote = (
    <>
      <div className="text-[10px] text-muted-foreground/60 flex flex-wrap gap-x-3">
        {model.stars.length > 0 && <span>★ {counts.starCount} star{counts.starCount !== 1 ? "s" : ""}</span>}
        <span>○ {counts.planetCount} planet{counts.planetCount !== 1 ? "s" : ""}</span>
        <span>⬡ {counts.enumeratedAsteroids} asteroid{counts.enumeratedAsteroids !== 1 ? "s" : ""}</span>
        {mannyModel.plotted.length > 0 && <span className="text-accent/80">♦ {mannyModel.plotted.length} manny{mannyModel.plotted.length !== 1 ? "s" : ""}</span>}
        {(otherProbes ?? []).length > 0 && <span>◈ {(otherProbes ?? []).length} probe{(otherProbes ?? []).length !== 1 ? "s" : ""}</span>}
      </div>
      {mannyModel.remote > 0 && (
        <div className="text-[9px] text-muted-foreground/40 italic">
          {mannyModel.remote} manny{mannyModel.remote !== 1 ? "s" : ""} working another system (visible via SCUT, not plotted here).
        </div>
      )}
      {undetailed && (
        <div className="text-[9px] text-muted-foreground/40 italic">
          Some bodies are counted but not individually detailed (shown as dashed rings). Bookmark or mine them to reveal detail.
        </div>
      )}
      {!model.hasContent && (
        <div className="text-[10px] text-muted-foreground/40 italic text-center py-2">
          Empty sector — no objects detected.
        </div>
      )}
      {model.hasContent && model.stars.length === 0 && (
        <div className="text-[10px] text-muted-foreground/40 italic">No primary star in this sector.</div>
      )}
    </>
  );

  const railPanel = (model.rail.length > 0 || model.beacons.length > 0) && (
    <div className={`border border-border/30 rounded p-1.5 space-y-1 overflow-y-auto ${expanded ? "max-h-none" : "max-h-28"}`}>
      <div className="text-[9px] text-muted-foreground/50 tracking-wider uppercase">User &amp; deployed objects</div>
      {model.rail.map((o, i) => {
            // Only scut_relays expose a creator id (createdByProbeId). Detached
            // containers carry NO creator field, so ownership is genuinely
            // unknowable — never assert "mine"; show a neutral "deployed" tag.
            const isRelay = o.type === "scut_relay";
            const own = isRelay ? ownership(o.createdByProbeId) : "unknown";
            return (
              <button
                key={`${o.type}:${o.id ?? i}`}
                onClick={() => setSelected(o)}
                className={`w-full flex items-center gap-1.5 text-left text-[10px] px-1 py-0.5 rounded hover:bg-primary/10 ${own === "mine" ? "text-accent" : own === "other" ? "text-muted-foreground/70" : "text-muted-foreground"}`}
              >
                <span>{objectIcon(o.type)}</span>
                <span className="truncate flex-1">{o.name ?? o.type.replace(/_/g, " ")}</span>
                {own === "mine" && <span className="text-[8px] text-accent/80">⚑ mine</span>}
                {own === "other" && <span className="text-[8px] text-muted-foreground/50">other</span>}
                {!isRelay && <span className="text-[8px] text-muted-foreground/50">deployed</span>}
              </button>
            );
          })}
          {model.beacons.map((w: any, i: number) => {
            const own = ownership(w.playerId);
            return (
              <button
                key={w.id ?? `beacon-${i}`}
                onClick={() => setSelected(w)}
                className={`w-full flex items-center gap-1.5 text-left text-[10px] px-1 py-0.5 rounded hover:bg-primary/10 ${own === "mine" ? "text-accent" : "text-muted-foreground/70"}`}
              >
                <span>⚑</span>
                <span className="truncate flex-1">{w.name}</span>
                <span className="text-[8px] text-muted-foreground/50">{own === "mine" ? "beacon · mine" : `beacon · ${w.playerName ?? "other"}`}</span>
              </button>
            );
          })}
    </div>
  );

  const detailPanel = selected && (
    <div className="border border-border/50 rounded p-2 space-y-1 bg-background/60 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-foreground glow-green flex items-center gap-1">
          <span>{objectIcon(selected.type)}</span>
          <span>{selected.name ?? selected.type?.replace(/_/g, " ")}</span>
        </span>
        <button onClick={() => setSelected(null)} className="text-muted-foreground/30 hover:text-muted-foreground text-[10px]">✕</button>
      </div>
      {selected.type === "scut_relay" && (
        <div className={`text-[10px] ${ownership(selected.createdByProbeId) === "mine" ? "text-accent" : "text-muted-foreground/70"}`}>
          {ownership(selected.createdByProbeId) === "mine"
            ? "Your relay"
            : `Relay by ${selected.createdByProbeName ?? "another probe"}`}
        </div>
      )}
      {selected.type === "self_probe" ? (
        <div className="text-[10px] text-muted-foreground/70 space-y-0.5">
          <div className="text-accent">Your probe{selected.status ? ` · ${String(selected.status).replace(/_/g, " ")}` : ""}</div>
          {selected.fuelDeuterium != null && <div>fuel {Number(selected.fuelDeuterium).toFixed(0)} deuterium</div>}
          {selected.integrityPercent != null && <div>integrity {Number(selected.integrityPercent).toFixed(0)}%</div>}
          {selected.sector && <div className="text-muted-foreground/40 font-mono">sector [{selected.sector.x},{selected.sector.y},{selected.sector.z}]</div>}
          <div className="text-muted-foreground/40 italic">position illustrative — placed to avoid overlaps</div>
        </div>
      ) : selected.type === "manny" ? (
        <div className="text-[10px] text-muted-foreground/70 space-y-0.5">
          <div className="text-accent">
            {(selected.currentTask ?? "idle").replace(/_/g, " ")}
            {selected.taskPhase && <span className="text-muted-foreground/60"> · {String(selected.taskPhase).replace(/_/g, " ")}</span>}
          </div>
          {selected.taskProgressPercent != null && (
            <div>
              task {Number(selected.taskProgressPercent).toFixed(0)}% complete
              {selected.taskTargetAmount != null && (
                <span className="text-muted-foreground/50"> · {Number(selected.taskDepositedAmount ?? 0).toFixed(2)}/{Number(selected.taskTargetAmount).toFixed(2)} ECE</span>
              )}
            </div>
          )}
          {selected.taskObjectId && (
            <div className="text-muted-foreground/50 font-mono">target {String(selected.taskObjectId).slice(0, 8)}…</div>
          )}
          {selected.taskEstimatedEndTime && (
            <div className="text-muted-foreground/40">ETA {new Date(selected.taskEstimatedEndTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          )}
        </div>
      ) : selected.type === "waypoint_bookmark" ? (
        <div className="text-[10px] text-muted-foreground/70">
          Beacon placed by {ownership(selected.playerId) === "mine" ? "you" : (selected.playerName ?? "another player")}
          {selected.createdAt && <span className="text-muted-foreground/40"> · {new Date(selected.createdAt).toLocaleDateString()}</span>}
        </div>
      ) : selected.type === "probe" ? (
        <div className="text-[10px] text-muted-foreground/70">
          Other probe{selected.moving ? " · in transit" : ""}
          {selected.id != null && <span className="text-muted-foreground/40 font-mono"> · id {String(selected.id)}</span>}
        </div>
      ) : (
        <SectorObject o={selected} />
      )}
    </div>
  );

  // Compact shell: everything stacked in the narrow sidebar (canvas fixed 300px).
  if (!expanded) {
    return (
      <div className="flex flex-col h-full gap-2">
        {header}
        {sectorLine}
        {canvasBox}
        {countsNote}
        {railPanel}
        {detailPanel}
      </div>
    );
  }

  // Expanded shell: a fullscreen overlay — big canvas on the left filling the
  // viewport, a scrollable info column (counts / user objects / detail) on the
  // right. Escape or the ⤡ close button returns to the compact sidebar view.
  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm p-4 flex flex-col gap-2 scanlines">
      {header}
      {sectorLine}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3">
        {canvasBox}
        <div className="w-full lg:w-80 shrink-0 flex flex-col gap-2 overflow-y-auto">
          {countsNote}
          {railPanel}
          {detailPanel}
        </div>
      </div>
    </div>
  );
}
