import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NETWORK_STYLE } from "./network-style";

export type LngLat = [number, number];

// One baked corridor (doc01.03): a polyline plus the truth of which Route colors
// share it — one entry for a solid trunk, several for a shared one.
export type TrackSegment = { points: LngLat[]; colors: string[] };

// The junctions (doc02.05) baked by the geometry pipeline: `over`/`under` index the
// segments array; `elevation[i]` is the per-vertex vertical offset (meters) for
// segment i, parallel to its points, ramping the over side of a crossing up and back.
export type TrackCrossing = { point: LngLat; over: number; under: number };
export type TrackMerge = { branch: number; trunk: number; attach: LngLat };
export type TrackGraph = {
  crossings: TrackCrossing[];
  elevation: number[][];
  partner: number[];
  merges: TrackMerge[];
  // The dissolved network outline (doc02.07): each polygon is [outerRing, ...holeRings]
  // in LngLat. The renderer extrudes each ring down into a platform edge.
  silhouette: LngLat[][][];
};

// What the layer lends a renderer: the meter-frame projection it already owns.
// Keeps the renderer free of MapLibre/origin math.
export type TrackContext = {
  toLocal(p: LngLat): { x: number; z: number };
};

// The boundary (doc01.03): how a corridor set plus its crossings becomes drawable 3D
// objects, and how a raycast hit reads back to a segment index. NetworkLayer knows
// only this — swap the implementation to change how track and junctions look without
// touching the layer or the rest of the scene.
export interface TrackRenderer {
  build(
    segments: TrackSegment[],
    graph: TrackGraph,
    ctx: TrackContext,
  ): TrackBuild;
}

export type TrackBuild = {
  // Added to the scene and used as raycast targets.
  objects: THREE.Object3D[];
  // Segment index for a hit on one of `objects`, or null if the hit is not track.
  segmentOfHit(hit: THREE.Intersection): number | null;
  // Semantic-zoom LOD (doc01.03): the layer feeds the current zoom and the ground
  // meters-per-pixel each time the map zooms, so the renderer can keep its pattern
  // legible in screen space (coarsen cells, fade caret marks) rather than aliasing.
  setZoom(zoom: number, metersPerPixel: number): void;
};

// The height of the highest part of the track (wall tops) — pucks and trains seat
// above this so they read as sitting on top of the track.
export function trackTopY(): number {
  return NETWORK_STYLE.track.surfaceY;
}

// A cross-section frame at a centerline vertex: its meter-frame center and the
// unit right-hand normal (perpendicular to the local tangent), so a profile point
// is center + normal·offset. A negative offset lies to the left of travel.
type Frame = { cx: number; cz: number; nx: number; nz: number };
type P2 = { x: number; z: number };

// One wide flat track per corridor (doc02.05). A corridor's two directions are fused
// into a single full-width ribbon (the partner segment is skipped), so there is no
// centerline seam to reason about — the median wall problem simply doesn't exist.
//   floor  — one full-width caret ribbon (-halfWidth..+halfWidth) on the corridor
//            centerline, lifted per-vertex by the baked crossing elevation. Where a
//            branch merges into a trunk it is extended to run along the trunk (sampling
//            the trunk centerline) and rides the baked merge-lift above it, so the merge
//            reads as joining-and-running-parallel rather than crossing-and-stopping.
//   walls  — the boundary of the assembled floor surface: each floor's outer rails are
//            welded and a rail used by exactly one floor gets a curb, one shared by two
//            (a tiled junction, or two coplanar floors) gets none. No thresholds — the
//            mesh topology decides; crossings, at different grades, never weld.
// Floors merge into one caret-shader mesh with a face→segment map for picking; walls
// merge into one unlit grey mesh (not pickable — clicks fall through to the floor).
export class FlatTrackRenderer implements TrackRenderer {
  build(
    segments: TrackSegment[],
    graph: TrackGraph,
    ctx: TrackContext,
  ): TrackBuild {
    // Each segment's cross-section frames paired with its baked per-vertex lift, both
    // deduped together so the lift stays aligned to the geometry it raises.
    const built = segments.map((seg, si) => {
      const kept = dedupeWithLift(seg.points, graph.elevation[si] ?? []);
      const local = kept.pts.map((p) => ctx.toLocal(p));
      return local.length >= 2
        ? { frames: framesOf(local), lift: kept.lift }
        : undefined;
    });

    // A corridor is drawn once, as a full-width ribbon. Own it if one-directional or the
    // lower-indexed half of a pair; the partner half is skipped (its geometry mirrors).
    const owns = (si: number) => {
      const p = graph.partner[si];
      return p < 0 || si < p;
    };
    const corridorOf = (si: number) => (owns(si) ? si : graph.partner[si]);

    // Junction protrusion (doc02.05): a branch was conformed only to *touch* its trunk
    // tangentially and then stop, which reads as crossing-and-stopping. Extend it to RUN
    // ALONG the trunk for `mergeProtrudeM` by sampling the trunk's own centerline forward
    // from the join — parallel by construction, whatever the approach angle — riding the
    // baked merge-lift above the trunk (so the overlap doesn't z-fight). Held as extra
    // frames+lift to graft onto the branch's merge end (head or tail).
    const mergeProtrudeM = NETWORK_STYLE.track.mergeProtrudeM;
    const headExt = new Array<Extension | null>(segments.length).fill(null);
    const tailExt = new Array<Extension | null>(segments.length).fill(null);
    for (const m of graph.merges) {
      const bc = corridorOf(m.branch);
      const tc = corridorOf(m.trunk);
      const bb = built[bc];
      const tb = built[tc];
      if (!bb || !tb) continue;
      const a = ctx.toLocal(m.attach);
      const Bf = bb.frames;
      const last = Bf.length - 1;
      const endIsLast =
        frameDistTo(Bf[last], a.x, a.z) < frameDistTo(Bf[0], a.x, a.z);
      const tip = endIsLast ? Bf[last] : Bf[0];
      const prev = endIsLast ? Bf[last - 1] : Bf[1];
      const fwd = { x: tip.cx - prev.cx, z: tip.cz - prev.cz };
      const tipLift = endIsLast ? bb.lift[last] : bb.lift[0];
      const ext = trunkProtrusion(tb.frames, a, fwd, mergeProtrudeM, tipLift);
      if (ext.frames.length < 2) continue;
      if (endIsLast) tailExt[bc] = ext;
      else headExt[bc] = ext;
    }

    const floors: { geo: THREE.BufferGeometry; seg: number }[] = [];
    const rails: RailEdge[] = [];
    built.forEach((b, si) => {
      if (!b || !owns(si)) return;
      let frames = b.frames;
      let lift = b.lift;
      const he = headExt[si];
      const te = tailExt[si];
      if (he) {
        // head extension runs outward from the branch start; reverse so it leads into it.
        frames = [...he.frames.slice().reverse(), ...frames];
        lift = [...he.lift.slice().reverse(), ...lift];
      }
      if (te) {
        frames = [...frames, ...te.frames];
        lift = [...lift, ...te.lift];
      }
      const along = southOriginArcLength(frames);
      const f = buildFloor(frames, along, segments[si].colors, lift);
      floors.push({ geo: f.geo, seg: si });
      rails.push(...f.rails);
    });

    // Walls = the boundary of the assembled floor surface. A rail edge used by exactly
    // one floor is an outline edge and gets a curb; a rail shared by two floors (a tiled
    // merge) is interior and gets none. No proximity thresholds — the mesh topology
    // decides. Floors at different grades (a crossing) don't weld, so both keep walls.
    const wallPos: number[] = [];
    const wallNor: number[] = [];
    extrudeBoundary(rails, wallPos, wallNor);

    const objects: THREE.Object3D[] = [];
    const maps = new Map<THREE.Object3D, FaceMap>();

    if (wallPos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(wallPos, 3),
      );
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(wallNor, 3));
      // No userData.kind: walls are not pickable, so a click falls through to floor.
      objects.push(new THREE.Mesh(geo, greyMaterial()));
    }

    const caretMat = caretMaterial();
    const floorMesh = mergeEntries(floors, caretMat);
    if (floorMesh) {
      floorMesh.mesh.userData.kind = "segment";
      objects.push(floorMesh.mesh);
      maps.set(floorMesh.mesh, floorMesh.faceMap);
    }

    return {
      objects,
      segmentOfHit: (hit) => {
        const map = maps.get(hit.object);
        if (!map || hit.faceIndex == null) return null;
        return segmentOfFace(map, hit.faceIndex);
      },
      setZoom: (zoom, metersPerPixel) => {
        const { chevron } = NETWORK_STYLE.track;
        caretMat.uniforms.uSpacing.value = Math.max(
          chevron.spacingM,
          chevron.minCellPx * metersPerPixel,
        );
        const t =
          (zoom - chevron.fadeStartZoom) /
          (chevron.fadeEndZoom - chevron.fadeStartZoom);
        caretMat.uniforms.uDetail.value = Math.min(1, Math.max(0, t));
      },
    };
  }
}

// A longitudinal outer-edge of a floor (a "rail"): its two endpoints at floor grade and
// the unit horizontal outward normal (which way a wall on it faces). Walls are the rails
// that bound the surface — see extrudeBoundary.
type RailEdge = { a: V3; b: V3; ox: number; oz: number };

// Boundary extraction: weld rail endpoints by quantized position, then a rail used by
// exactly one floor is an outline edge (extrude a curb) while one shared by two floors —
// a tiled merge (Stage C) — is interior and gets none. Welding includes Y, so floors at
// different grades (a crossing) never share an edge and both keep their walls.
function extrudeBoundary(rails: RailEdge[], pos: number[], nor: number[]) {
  const Q = 0.5; // weld quantum, meters
  const ids = new Map<string, number>();
  const idOf = (p: V3): number => {
    const k = `${Math.round(p.x / Q)},${Math.round(p.y / Q)},${Math.round(p.z / Q)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    return id;
  };
  const edges = new Map<string, { rail: RailEdge; count: number }>();
  for (const r of rails) {
    const ia = idOf(r.a);
    const ib = idOf(r.b);
    const key = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`;
    const e = edges.get(key);
    if (e) e.count++;
    else edges.set(key, { rail: r, count: 1 });
  }
  for (const { rail, count } of edges.values()) {
    if (count === 1) curbFromEdge(rail, pos, nor);
  }
}

// A straddling curb along a rail: inner face, outer face, and top cap, from the rail's
// floor grade up by wallHeight, `wallThickness` wide across the outward normal.
function curbFromEdge(r: RailEdge, pos: number[], nor: number[]) {
  const { wallHeight, wallThickness } = NETWORK_STYLE.track;
  const t = wallThickness / 2;
  const { a, b, ox, oz } = r;
  const off = (p: V3, s: number, y: number): V3 => ({
    x: p.x + ox * t * s,
    y,
    z: p.z + oz * t * s,
  });
  const aIn = off(a, -1, a.y);
  const aInT = off(a, -1, a.y - wallHeight);
  const aOut = off(a, 1, a.y);
  const aOutT = off(a, 1, a.y - wallHeight);
  const bIn = off(b, -1, b.y);
  const bInT = off(b, -1, b.y - wallHeight);
  const bOut = off(b, 1, b.y);
  const bOutT = off(b, 1, b.y - wallHeight);
  pushTri(pos, nor, aIn, bIn, aInT);
  pushTri(pos, nor, aInT, bIn, bInT);
  pushTri(pos, nor, aOut, aOutT, bOut);
  pushTri(pos, nor, bOut, aOutT, bOutT);
  pushTri(pos, nor, aInT, bInT, aOutT);
  pushTri(pos, nor, aOutT, bInT, bOutT);
}

// mergeGeometries concatenates in push order (useGroups=false), so the running
// triangle count gives each entry its face range in the merged mesh.
type FaceMap = { triStart: number[]; segIds: number[] };

function mergeEntries(
  entries: { geo: THREE.BufferGeometry; seg: number }[],
  material: THREE.Material,
): { mesh: THREE.Mesh; faceMap: FaceMap } | null {
  if (entries.length === 0) return null;
  const faceMap: FaceMap = { triStart: [], segIds: [] };
  let tri = 0;
  for (const e of entries) {
    faceMap.triStart.push(tri);
    faceMap.segIds.push(e.seg);
    tri += e.geo.getAttribute("position").count / 3;
  }
  const merged = mergeGeometries(
    entries.map((e) => e.geo),
    false,
  );
  for (const e of entries) e.geo.dispose();
  const mesh = new THREE.Mesh(merged, material);
  mesh.userData.faceMap = faceMap;
  return { mesh, faceMap };
}

// One full-width corridor floor: a quad strip from the right edge (+halfWidth) to the
// left edge (-halfWidth), at `surfaceY` plus the per-vertex crossing lift. Every vertex
// carries its across-track distance from center (`aU`, signed), its along-track distance
// from the south end (`aV`), and the palette padded to 4 with a color count. The caret
// shader uses |aU|, so the chevron apex sits on the centerline and points north.
function buildFloor(
  frames: Frame[],
  along: number[],
  colors: string[],
  lift: number[],
): { geo: THREE.BufferGeometry; rails: RailEdge[] } {
  const { halfWidth, surfaceY } = NETWORK_STYLE.track;
  const pos: number[] = [];
  const uA: number[] = [];
  const vA: number[] = [];
  const rails: RailEdge[] = [];
  const push = (p: V3, u: number, v: number) => {
    pos.push(p.x, p.y, p.z);
    uA.push(u);
    vA.push(v);
  };
  for (let i = 0; i < frames.length - 1; i++) {
    const y0 = surfaceY + lift[i];
    const y1 = surfaceY + lift[i + 1];
    const ro0 = at(frames[i], halfWidth, y0);
    const lo0 = at(frames[i], -halfWidth, y0);
    const ro1 = at(frames[i + 1], halfWidth, y1);
    const lo1 = at(frames[i + 1], -halfWidth, y1);
    push(ro0, halfWidth, along[i]);
    push(ro1, halfWidth, along[i + 1]);
    push(lo0, -halfWidth, along[i]);
    push(lo0, -halfWidth, along[i]);
    push(ro1, halfWidth, along[i + 1]);
    push(lo1, -halfWidth, along[i + 1]);
    // The two rails of this strip, with their outward normal (averaged over the step),
    // for boundary extraction into walls.
    const nx = frames[i].nx + frames[i + 1].nx;
    const nz = frames[i].nz + frames[i + 1].nz;
    const nl = Math.hypot(nx, nz) || 1;
    rails.push({ a: ro0, b: ro1, ox: nx / nl, oz: nz / nl });
    rails.push({ a: lo0, b: lo1, ox: -nx / nl, oz: -nz / nl });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aU", new THREE.Float32BufferAttribute(uA, 1));
  geo.setAttribute("aV", new THREE.Float32BufferAttribute(vA, 1));
  // The caret shader is unlit; a flat +Y normal is enough for a merge-compatible
  // attribute set.
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  attachPalette(geo, colors);
  return { geo, rails };
}

type V3 = { x: number; y: number; z: number };

function at(f: Frame, off: number, y: number): V3 {
  return { x: f.cx + f.nx * off, y, z: f.cz + f.nz * off };
}

function frameDistTo(f: Frame, x: number, z: number): number {
  return Math.hypot(f.cx - x, f.cz - z);
}

// Extra frames (with per-frame lift) grafted onto a branch's merge end so it runs along
// the trunk rather than stopping at it.
type Extension = { frames: Frame[]; lift: number[] };

// Sample the trunk centerline forward from a branch's attach point for `protrudeM`, so
// the branch can be extended to run collinear with — i.e. exactly parallel to — the
// trunk regardless of how it approached. Frames take the trunk's center + normal, each
// at the given lift (the branch rides above the trunk on the baked merge-lift).
function trunkProtrusion(
  trunk: Frame[],
  attach: { x: number; z: number },
  fwd: { x: number; z: number },
  protrudeM: number,
  lift: number,
): Extension {
  const cum = [0];
  for (let i = 1; i < trunk.length; i++)
    cum.push(
      cum[i - 1] +
        Math.hypot(
          trunk[i].cx - trunk[i - 1].cx,
          trunk[i].cz - trunk[i - 1].cz,
        ),
    );
  const total = cum[cum.length - 1];

  // arc position of the attach (nearest projection onto the trunk polyline)
  let bd = Number.POSITIVE_INFINITY;
  let s0 = 0;
  for (let i = 0; i < trunk.length - 1; i++) {
    const dx = trunk[i + 1].cx - trunk[i].cx;
    const dz = trunk[i + 1].cz - trunk[i].cz;
    const l2 = dx * dx + dz * dz || 1;
    let t =
      ((attach.x - trunk[i].cx) * dx + (attach.z - trunk[i].cz) * dz) / l2;
    t = Math.min(1, Math.max(0, t));
    const d = Math.hypot(
      attach.x - (trunk[i].cx + t * dx),
      attach.z - (trunk[i].cz + t * dz),
    );
    if (d < bd) {
      bd = d;
      s0 = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }

  // which way along the trunk matches the branch's travel
  const near = sampleTrunkAt(trunk, cum, s0);
  const ahead = sampleTrunkAt(trunk, cum, Math.min(total, s0 + 1));
  const dir =
    (ahead.cx - near.cx) * fwd.x + (ahead.cz - near.cz) * fwd.z >= 0 ? 1 : -1;

  const frames: Frame[] = [];
  const lifts: number[] = [];
  const stepM = 12;
  for (let d = 0; d <= protrudeM; d += stepM) {
    const s = s0 + dir * d;
    if (s < 0 || s > total) break;
    frames.push(sampleTrunkAt(trunk, cum, s));
    lifts.push(lift);
  }
  return { frames, lift: lifts };
}

// A Frame (center + unit normal) interpolated at arc-length `s` along a polyline of frames.
function sampleTrunkAt(trunk: Frame[], cum: number[], s: number): Frame {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const a = trunk[i - 1];
  const b = trunk[i];
  const nx = a.nx + (b.nx - a.nx) * t;
  const nz = a.nz + (b.nz - a.nz) * t;
  const nl = Math.hypot(nx, nz) || 1;
  return {
    cx: a.cx + (b.cx - a.cx) * t,
    cz: a.cz + (b.cz - a.cz) * t,
    nx: nx / nl,
    nz: nz / nl,
  };
}

function pushTri(pos: number[], nor: number[], p: V3, q: V3, r: V3) {
  const ux = q.x - p.x;
  const uy = q.y - p.y;
  const uz = q.z - p.z;
  const vx = r.x - p.x;
  const vy = r.y - p.y;
  const vz = r.z - p.z;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  for (const pt of [p, q, r]) {
    pos.push(pt.x, pt.y, pt.z);
    nor.push(nx, ny, nz);
  }
}

// Up to four palette colors per vertex plus a count, so the merged floor mesh can
// draw each segment's own colors in the shader (max colors baked is 4, doc01.03).
function attachPalette(geo: THREE.BufferGeometry, colors: string[]) {
  const n = geo.getAttribute("position").count;
  const rgb = colors.slice(0, 4).map(hexToRgb);
  while (rgb.length < 4) rgb.push(rgb[0] ?? [1, 1, 1]);
  const count = Math.max(1, Math.min(4, colors.length));
  for (let c = 0; c < 4; c++) {
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[3 * i] = rgb[c][0];
      arr[3 * i + 1] = rgb[c][1];
      arr[3 * i + 2] = rgb[c][2];
    }
    geo.setAttribute(`aCol${c}`, new THREE.BufferAttribute(arr, 3));
  }
  const counts = new Float32Array(n).fill(count);
  geo.setAttribute("aColCount", new THREE.BufferAttribute(counts, 1));
}

function greyMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: NETWORK_STYLE.track.edgeColor,
    emissive: NETWORK_STYLE.track.edgeColor,
    emissiveIntensity: NETWORK_STYLE.track.edgeEmissiveIntensity,
    side: THREE.DoubleSide,
  });
}

// The caret shader (doc01.03). One bent coordinate `g = along + |across|·tan(bendDeg)`
// partitions the ribbon into chevron cells: `floor(g/spacing)` picks the palette
// color and the black caret line falls where `g` crosses a cell boundary, so the "^"
// mark is exactly the seam between two colors — color and mark cannot drift apart.
// The apex sits on the centerline (across=0) and the arms trail south as |across|
// grows, so it points north. A shared trunk cycles its colors cell-to-cell. Unlit —
// the floor reads at full Route color like the trains. uSpacing (cell period) and
// uDetail (caret opacity) are driven per-zoom by setZoom for screen-space LOD.
function caretMaterial(): THREE.ShaderMaterial {
  const { chevron } = NETWORK_STYLE.track;
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uSpacing: { value: chevron.spacingM },
      uTan: { value: Math.tan((chevron.bendDeg * Math.PI) / 180) },
      uLine: { value: chevron.lineM },
      uDetail: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      attribute vec3 aCol0;
      attribute vec3 aCol1;
      attribute vec3 aCol2;
      attribute vec3 aCol3;
      attribute float aColCount;
      varying float vU;
      varying float vV;
      varying vec3 vC0;
      varying vec3 vC1;
      varying vec3 vC2;
      varying vec3 vC3;
      varying float vCount;
      void main() {
        vU = aU; vV = aV;
        vC0 = aCol0; vC1 = aCol1; vC2 = aCol2; vC3 = aCol3;
        vCount = aColCount;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uSpacing;
      uniform float uTan;
      uniform float uLine;
      uniform float uDetail;
      varying float vU;
      varying float vV;
      varying vec3 vC0;
      varying vec3 vC1;
      varying vec3 vC2;
      varying vec3 vC3;
      varying float vCount;
      void main() {
        // One bent coordinate drives both the color cell and the caret, so the "^"
        // is exactly the boundary between two colors.
        float g = vV + abs(vU) * uTan;
        float cell = g / uSpacing;
        float m = mod(floor(cell), vCount);
        vec3 col = vC0;
        if (m > 0.5) col = vC1;
        if (m > 1.5) col = vC2;
        if (m > 2.5) col = vC3;
        // Caret line at the cell seam, antialiased over ~one pixel of g and faded by
        // the LOD so it disappears when too small to read.
        float f = fract(cell);
        float dist = min(f, 1.0 - f) * uSpacing;
        float aa = fwidth(g);
        float line = (1.0 - smoothstep(uLine - aa, uLine + aa, dist)) * uDetail;
        col = mix(col, vec3(0.0), line);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Largest triStart[i] <= faceIndex gives the segment owning that triangle.
function segmentOfFace(map: FaceMap, faceIndex: number): number | null {
  const { triStart, segIds } = map;
  let lo = 0;
  let hi = triStart.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (triStart[mid] <= faceIndex) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? segIds[ans] : null;
}

// Per-vertex frames along a polyline: center plus the unit right-hand normal of the
// central-difference tangent, so a profile point is center + normal·offset.
function framesOf(pts: P2[]): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const len = Math.hypot(tx, tz) || 1;
    // Right-hand perpendicular (tz, -tx) of the unit tangent.
    out.push({ cx: pts[i].x, cz: pts[i].z, nx: tz / len, nz: -tx / len });
  }
  return out;
}

// Along-track distance for each frame, measured from the corridor's south end
// (local +z is south, so the frame with the largest z). Both direction polylines
// of a corridor thus share one along-track field, keeping their caret marks in
// phase and pointing the same way (north) where they meet at the centerline.
function southOriginArcLength(frames: Frame[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < frames.length; i++) {
    cum.push(
      cum[i - 1] +
        Math.hypot(
          frames[i].cx - frames[i - 1].cx,
          frames[i].cz - frames[i - 1].cz,
        ),
    );
  }
  const startIsSouth = frames[0].cz >= frames[frames.length - 1].cz;
  const total = cum[cum.length - 1];
  return startIsSouth ? cum : cum.map((c) => total - c);
}

// Drop consecutive duplicate points, carrying each kept point's baked lift so the
// elevation profile stays index-aligned to the geometry after deduping.
function dedupeWithLift(
  points: LngLat[],
  elev: number[],
): { pts: LngLat[]; lift: number[] } {
  const pts: LngLat[] = [];
  const lift: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = pts[pts.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    pts.push(p);
    lift.push(elev[i] ?? 0);
  }
  return { pts, lift };
}

// Parse "#rrggbb" straight to sRGB 0..1 floats. The caret shader writes gl_FragColor
// directly (no material color-management pass), so passing sRGB components paints
// the literal baked hex — matching how the palette reads.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  return [r || 0, g || 0, b || 0];
}
