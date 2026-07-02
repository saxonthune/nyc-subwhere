import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NETWORK_STYLE } from "./network-style";

export type LngLat = [number, number];

// One baked corridor (doc01.03): a polyline plus the truth of which Route colors
// share it — one entry for a solid trunk, several for a shared one.
export type TrackSegment = { points: LngLat[]; colors: string[] };

// The junction topology (doc02.05), baked by the geometry pipeline. `seg` fields
// index into the segments array. A `junction` is a real split/merge whose gap the
// renderer fills with a gore; a `crossing` is two unconnected segments the renderer
// grade-separates (`over` drawn above `under`).
export type EdgeEnd = { seg: number; end: "start" | "end" };
export type TrackNode =
  | { kind: "junction"; point: LngLat; ends: EdgeEnd[] }
  | { kind: "crossing"; point: LngLat; over: number; under: number };
export type TrackGraph = { nodes: TrackNode[] };

// What the layer lends a renderer: the meter-frame projection it already owns.
// Keeps the renderer free of MapLibre/origin math.
export type TrackContext = {
  toLocal(p: LngLat): { x: number; z: number };
};

// The boundary (doc01.03): how a corridor set plus its junction graph becomes
// drawable 3D objects, and how a raycast hit reads back to a segment index.
// NetworkLayer knows only this — swap the implementation to change how track looks
// (and how junctions are handled) without touching the layer or the rest of the scene.
export interface TrackRenderer {
  build(segments: TrackSegment[], graph: TrackGraph, ctx: TrackContext): TrackBuild;
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
  const { surfaceY, wallHeight } = NETWORK_STYLE.track;
  return surfaceY + wallHeight;
}

// A cross-section frame at a centerline vertex: its meter-frame center and the
// unit right-hand normal (perpendicular to the local tangent), so a profile point
// is center + normal·offset. A negative offset lies to the left of travel.
type Frame = { cx: number; cz: number; nx: number; nz: number };
type P2 = { x: number; z: number };

// Tubes → one wide flat track (doc01.03), stitched at junctions (doc02.05). Each
// corridor's two direction polylines draw as half-ribbons meeting at the centerline,
// so together they tile one wide colored floor with a grey wall + wing on each outer
// edge. The floor carries north-pointing caret marks that also delimit color cells.
// Junction handling is driven by the baked graph, one strategy per node kind:
//   junction — trim every incident edge back by `trimRadiusM`, then fill the gap
//              with a flat gore patch, so diverging ribbons meet cleanly and their
//              walls stop at the mouth instead of colliding.
//   crossing — raise the priority (`over`) edge over a short bridge span so it
//              clears the `under` edge's walls; no z-fighting, reads as grade
//              separation.
// Floors merge into one shader mesh, grey structure into one standard mesh, and gore
// patches into one unlit vertex-colored mesh; each keeps a face→segment map.
export class FlatTrackRenderer implements TrackRenderer {
  build(segments: TrackSegment[], graph: TrackGraph, ctx: TrackContext): TrackBuild {
    type Entry = { geo: THREE.BufferGeometry; seg: number };
    const floors: Entry[] = [];
    const greys: Entry[] = [];
    const patches: Entry[] = [];

    const { trimRadiusM } = NETWORK_STYLE.track.junction;

    // Which ends to trim (seg,end → junction node), and where the over-edges of
    // crossings sit (seg → local crossing points), from the graph.
    const junctions = graph.nodes.filter(
      (n): n is Extract<TrackNode, { kind: "junction" }> => n.kind === "junction",
    );
    const trimOf = new Map<number, { start?: number; end?: number }>();
    junctions.forEach((node, ji) => {
      for (const e of node.ends) {
        const t = trimOf.get(e.seg) ?? {};
        t[e.end] = ji;
        trimOf.set(e.seg, t);
      }
    });
    const crossOf = new Map<number, P2[]>();
    for (const node of graph.nodes) {
      if (node.kind !== "crossing") continue;
      const arr = crossOf.get(node.over) ?? [];
      arr.push(ctx.toLocal(node.point));
      crossOf.set(node.over, arr);
    }

    // The trimmed mouth frame of every edge-end at each junction, gathered as the
    // edges are built so the gore patch can span them.
    const nodeMouths: Frame[][] = junctions.map(() => []);

    segments.forEach((seg, si) => {
      const local = dedupeConsecutive(seg.points).map((p) => ctx.toLocal(p));
      if (local.length < 2) return;
      const tr = trimOf.get(si);
      const doStart = tr?.start !== undefined;
      const doEnd = tr?.end !== undefined;
      const pts = trimPolyline(local, doStart, doEnd, trimRadiusM);
      if (pts.length < 2) return;
      const frames = framesOf(pts);
      const along = southOriginArcLength(pts);
      const lift = liftAlong(pts, crossOf.get(si) ?? []);
      floors.push({ geo: buildFloor(frames, along, seg.colors, lift), seg: si });
      greys.push({ geo: buildGrey(frames, lift), seg: si });
      if (doStart) nodeMouths[tr!.start!].push(frames[0]);
      if (doEnd) nodeMouths[tr!.end!].push(frames[frames.length - 1]);
    });

    junctions.forEach((node, ji) => {
      const mouths = nodeMouths[ji];
      if (mouths.length < 2) return;
      let widest = -1;
      let color = "#ffffff";
      let seg = node.ends[0].seg;
      for (const e of node.ends) {
        const cols = segments[e.seg]?.colors ?? [];
        if (cols.length > widest) {
          widest = cols.length;
          color = cols[0] ?? color;
          seg = e.seg;
        }
      }
      patches.push({ geo: buildPatch(mouths, color), seg });
    });

    const objects: THREE.Object3D[] = [];
    const maps = new Map<THREE.Object3D, FaceMap>();
    const add = (
      entries: Entry[],
      material: THREE.Material,
    ): void => {
      const built = mergeEntries(entries, material);
      if (!built) return;
      built.mesh.userData.kind = "segment";
      objects.push(built.mesh);
      maps.set(built.mesh, built.faceMap);
    };

    add(greys, greyMaterial());
    const caretMat = caretMaterial();
    add(floors, caretMat);
    add(patches, patchMaterial());

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

// One half-ribbon floor: a quad strip on the left of the centerline, from the
// median (`medianGap` from center) out to the full half-width, at `surfaceY` plus
// the per-vertex grade-separation lift. Every vertex carries its across-track
// distance from center (`aU`), its along-track distance from the south end (`aV`),
// and the segment palette padded to 4 with a color count.
function buildFloor(
  frames: Frame[],
  along: number[],
  colors: string[],
  lift: number[],
): THREE.BufferGeometry {
  const { medianGap, halfWidth, surfaceY } = NETWORK_STYLE.track;
  const pos: number[] = [];
  const uA: number[] = [];
  const vA: number[] = [];
  const push = (p: V3, u: number, v: number) => {
    pos.push(p.x, p.y, p.z);
    uA.push(u);
    vA.push(v);
  };
  for (let i = 0; i < frames.length - 1; i++) {
    const y0 = surfaceY + lift[i];
    const y1 = surfaceY + lift[i + 1];
    const li0 = at(frames[i], -medianGap, y0);
    const lo0 = at(frames[i], -halfWidth, y0);
    const li1 = at(frames[i + 1], -medianGap, y1);
    const lo1 = at(frames[i + 1], -halfWidth, y1);
    push(li0, medianGap, along[i]);
    push(li1, medianGap, along[i + 1]);
    push(lo0, halfWidth, along[i]);
    push(lo0, halfWidth, along[i]);
    push(li1, medianGap, along[i + 1]);
    push(lo1, halfWidth, along[i + 1]);
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
  return geo;
}

// The grey structure for one half-ribbon: a wall standing on the outer edge and a
// wing flanging out past it, lifted per vertex to match the floor's grade at
// crossings. No inner (median) wall — the two halves read as one wide track.
function buildGrey(frames: Frame[], lift: number[]): THREE.BufferGeometry {
  const { halfWidth, surfaceY, wallHeight, wallThickness, wingWidth, wingY } =
    NETWORK_STYLE.track;
  const outer = halfWidth;
  const wallOuter = outer + wallThickness;
  const wingOuter = wallOuter + wingWidth;
  const floorTopY = surfaceY;
  const wallTopY = surfaceY + wallHeight;
  const wingTopY = surfaceY + wingY;

  const pos: number[] = [];
  const nor: number[] = [];
  // Left side only (negative offsets = outer edge of this half-ribbon).
  sweep(frames, pos, nor, lift, -outer, floorTopY, -outer, wallTopY); // wall inner face
  sweep(frames, pos, nor, lift, -outer, wallTopY, -wallOuter, wallTopY); // wall top
  sweep(frames, pos, nor, lift, -wallOuter, wallTopY, -wallOuter, wingTopY); // wall outer
  sweep(frames, pos, nor, lift, -wallOuter, wingTopY, -wingOuter, wingTopY); // wing top
  sweep(frames, pos, nor, lift, -wingOuter, wingTopY, -wingOuter, floorTopY); // wing outer

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

// A quad strip along the centerline between two profile edges, each edge given by
// an across-track offset and a height; the per-vertex lift is added to both heights.
function sweep(
  frames: Frame[],
  pos: number[],
  nor: number[],
  lift: number[],
  aOff: number,
  aY: number,
  bOff: number,
  bY: number,
) {
  for (let i = 0; i < frames.length - 1; i++) {
    const a0 = at(frames[i], aOff, aY + lift[i]);
    const a1 = at(frames[i + 1], aOff, aY + lift[i + 1]);
    const b0 = at(frames[i], bOff, bY + lift[i]);
    const b1 = at(frames[i + 1], bOff, bY + lift[i + 1]);
    pushTri(pos, nor, a0, a1, b0);
    pushTri(pos, nor, b0, a1, b1);
  }
}

// A flat gore patch filling a junction: a fan over the ring of trimmed edge mouths,
// each mouth contributing its two full-width corners. Fanning from the corners'
// centroid fills the star-shaped gap the trims opened. Solid color (the busiest
// incident edge's) since it is a small connector, not a stretch of track.
function buildPatch(mouths: Frame[], color: string): THREE.BufferGeometry {
  const { halfWidth, surfaceY } = NETWORK_STYLE.track;
  const corners: P2[] = [];
  for (const f of mouths) {
    corners.push({ x: f.cx - f.nx * halfWidth, z: f.cz - f.nz * halfWidth });
    corners.push({ x: f.cx + f.nx * halfWidth, z: f.cz + f.nz * halfWidth });
  }
  let cx = 0;
  let cz = 0;
  for (const p of corners) {
    cx += p.x;
    cz += p.z;
  }
  cx /= corners.length;
  cz /= corners.length;
  corners.sort(
    (a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx),
  );

  const rgb = hexToRgb(color);
  const pos: number[] = [];
  const col: number[] = [];
  const pushV = (x: number, z: number) => {
    pos.push(x, surfaceY, z);
    col.push(rgb[0], rgb[1], rgb[2]);
  };
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % corners.length];
    pushV(cx, cz);
    pushV(a.x, a.z);
    pushV(b.x, b.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

type V3 = { x: number; y: number; z: number };

function at(f: Frame, off: number, y: number): V3 {
  return { x: f.cx + f.nx * off, y, z: f.cz + f.nz * off };
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
    color: NETWORK_STYLE.track.greyColor,
    side: THREE.DoubleSide,
  });
}

function patchMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
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

// Trim a polyline back from one or both ends by `radius` meters, so a junction gore
// can fill the opened gap and walls stop short of the node. Each side is clamped to
// 40% of the total length so a short segment never collapses.
function trimPolyline(
  pts: P2[],
  trimStart: boolean,
  trimEnd: boolean,
  radius: number,
): P2[] {
  if (!trimStart && !trimEnd) return pts;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += dist2(pts[i], pts[i + 1]);
  const cap = total * 0.4;
  let out = pts;
  if (trimStart) out = cutFromStart(out, Math.min(radius, cap));
  if (trimEnd) {
    out = cutFromStart([...out].reverse(), Math.min(radius, cap)).reverse();
  }
  return out.length >= 2 ? out : pts;
}

function cutFromStart(pts: P2[], r: number): P2[] {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = dist2(pts[i], pts[i + 1]);
    if (acc + d >= r) {
      const t = (r - acc) / d;
      const cut = {
        x: pts[i].x + t * (pts[i + 1].x - pts[i].x),
        z: pts[i].z + t * (pts[i + 1].z - pts[i].z),
      };
      return [cut, ...pts.slice(i + 1)];
    }
    acc += d;
  }
  return pts;
}

// Per-vertex grade-separation lift: a raised-cosine bridge of height `crossLiftM`
// and along-track length `bridgeLenM` centered on each crossing where this edge is
// the priority (`over`) side, so it clears the other edge's walls. Overlapping
// bridges take the max, not the sum, so the crest never doubles.
function liftAlong(pts: P2[], crosses: P2[]): number[] {
  const n = pts.length;
  if (crosses.length === 0) return new Array(n).fill(0);
  const { crossLiftM, bridgeLenM } = NETWORK_STYLE.track.junction;
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + dist2(pts[i - 1], pts[i]));
  const centers = crosses.map((c) => nearestArc(pts, arc, c));
  const half = bridgeLenM / 2;
  const lift = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let l = 0;
    for (const s of centers) {
      const x = arc[i] - s;
      if (Math.abs(x) < half) {
        l = Math.max(l, crossLiftM * 0.5 * (1 + Math.cos((Math.PI * x) / half)));
      }
    }
    lift[i] = l;
  }
  return lift;
}

function nearestArc(pts: P2[], arc: number[], c: P2): number {
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x;
    const az = pts[i].z;
    const dx = pts[i + 1].x - ax;
    const dz = pts[i + 1].z - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((c.x - ax) * dx + (c.z - az) * dz) / len2;
    t = Math.min(1, Math.max(0, t));
    const px = ax + t * dx;
    const pz = az + t * dz;
    const d = Math.hypot(c.x - px, c.z - pz);
    if (d < best) {
      best = d;
      bestS = arc[i] + t * Math.sqrt(len2);
    }
  }
  return bestS;
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

// Along-track distance for each vertex, measured from the corridor's south end
// (local +z is south, so the vertex with the largest z). Both direction polylines
// of a corridor thus share one along-track field, keeping their caret marks in
// phase and pointing the same way (north) where they meet at the centerline.
function southOriginArcLength(pts: P2[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + dist2(pts[i - 1], pts[i]));
  }
  const startIsSouth = pts[0].z >= pts[pts.length - 1].z;
  const total = cum[cum.length - 1];
  return startIsSouth ? cum : cum.map((c) => total - c);
}

function dist2(a: P2, b: P2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function dedupeConsecutive(points: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

// Parse "#rrggbb" straight to sRGB 0..1 floats. The caret shader writes gl_FragColor
// directly (no material color-management pass), so passing sRGB components paints
// the literal baked hex — matching how the palette reads.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r || 0, g || 0, b || 0];
}
