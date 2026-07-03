import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NETWORK_STYLE } from "./network-style";

export type LngLat = [number, number];

// One baked corridor (doc01.03): a polyline plus the truth of which Route colors
// share it — one entry for a solid trunk, several for a shared one.
export type TrackSegment = { points: LngLat[]; colors: string[] };

// The junctions (doc02.07) baked by the geometry pipeline: `over`/`under` index the
// segments array; `grade[i]` is segment i's constant grade level (0 = ground), used as a
// draw order so overlapping floors resolve by depth.
export type TrackCrossing = { point: LngLat; over: number; under: number };
export type TrackMerge = { branch: number; trunk: number; attach: LngLat };
export type TrackGraph = {
  crossings: TrackCrossing[];
  // Constant grade level per segment (doc02.07): higher levels are drawn in front so
  // overlapping floors resolve by depth. Parallel to segments; 0 is ground.
  grade: number[];
  partner: number[];
  // Per segment, whether its [start, end] is an angled merge into a trunk (doc02.07): the
  // floor tapers to a point there so the branch tucks under like a turnout.
  taper: [boolean, boolean][];
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

// A raised platform network (doc02.07). Junction tessellation is split:
//   floor  — one full-width caret ribbon (-halfWidth..+halfWidth) per corridor, flat on the
//            corridor centerline at `surfaceY` (a corridor's two directions are fused, the
//            partner segment skipped, so there is no centerline seam). Floors carry the
//            per-corridor palette for the caret shader and are grouped by baked grade level
//            (doc02.07): each level is one mesh with a depth offset, so where floors overlap
//            the higher grade wins the depth test — junctions read without z-fighting, and
//            because grade is draw order rather than height, nothing bumps or floats.
//   walls  — the baked silhouette (doc02.07): every centerline buffered and boolean-unioned
//            in the geometry pipeline, so merges/branches dissolve into one outline with no
//            seam. Each outline ring is extruded down from the platform top to ground as a
//            glowing edge. No boundary extraction or per-junction special-casing here.
// Floors merge into one caret-shader mesh with a face→segment map for picking; walls
// merge into one unlit emissive mesh (not pickable — clicks fall through to the floor).
export class FlatTrackRenderer implements TrackRenderer {
  build(
    segments: TrackSegment[],
    graph: TrackGraph,
    ctx: TrackContext,
  ): TrackBuild {
    // Each corridor's cross-section frames. Floors are flat at `surfaceY`; grade is a draw
    // order, not a height (doc02.07), so the geometry never bumps.
    const built = segments.map((seg) => {
      const local = dedupeWithLift(seg.points, []).pts.map((p) =>
        ctx.toLocal(p),
      );
      return local.length >= 2 ? framesOf(local) : undefined;
    });

    // A corridor is drawn once, as a full-width ribbon. Own it if one-directional or the
    // lower-indexed half of a pair; the partner half is skipped (its geometry mirrors).
    const owns = (si: number) => {
      const p = graph.partner[si];
      return p < 0 || si < p;
    };

    // Platform edges (doc02.07): extrude each baked silhouette ring down from the platform
    // top to ground. The union computed the whole flat outline, so there is no boundary
    // extraction and no per-junction special-casing.
    const wallPos: number[] = [];
    const wallNor: number[] = [];
    buildSilhouetteWalls(graph.silhouette, ctx, wallPos, wallNor);

    // Group floors by grade level. Each level is one mesh with a depth offset so higher
    // grades win the depth test where floors overlap — crossings and near-parallel runs
    // resolve cleanly without lifting the geometry.
    const byLevel = new Map<
      number,
      { geo: THREE.BufferGeometry; seg: number }[]
    >();
    const { halfWidth } = NETWORK_STYLE.track;
    built.forEach((frames, si) => {
      if (!frames || !owns(si)) return;
      // Fuse the corridor's two directions onto their shared midline so the fill covers the
      // same footprint the silhouette unions (else an offset between the directions leaves the
      // colour short of the far wall). One-directional corridors keep their own centerline.
      const partnerFrames = graph.partner[si] >= 0 ? built[graph.partner[si]] : undefined;
      const { frames: fused, halfW } = partnerFrames
        ? fuseFrames(frames, partnerFrames, halfWidth)
        : { frames, halfW: frames.map(() => halfWidth) };
      const along = southOriginArcLength(fused);
      const level = graph.grade[si] ?? 0;
      const taper = graph.taper?.[si] ?? [false, false];
      const geo = buildFloor(fused, along, halfW, segments[si].colors, taper);
      const g = byLevel.get(level);
      if (g) g.push({ geo, seg: si });
      else byLevel.set(level, [{ geo, seg: si }]);
    });

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

    const caretMats: THREE.ShaderMaterial[] = [];
    for (const [level, entries] of byLevel) {
      const mat = caretMaterial();
      // Pull higher grades toward the camera in the depth buffer (a decal-style bias), so a
      // busier line drawn on top of what it crosses wins without any height difference.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -level;
      mat.polygonOffsetUnits = -level * 4;
      caretMats.push(mat);
      const floorMesh = mergeEntries(entries, mat);
      if (floorMesh) {
        floorMesh.mesh.userData.kind = "segment";
        objects.push(floorMesh.mesh);
        maps.set(floorMesh.mesh, floorMesh.faceMap);
      }
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
        const uSpacing = Math.max(
          chevron.spacingM,
          chevron.minCellPx * metersPerPixel,
        );
        const t =
          (zoom - chevron.fadeStartZoom) /
          (chevron.fadeEndZoom - chevron.fadeStartZoom);
        const uDetail = Math.min(1, Math.max(0, t));
        for (const mat of caretMats) {
          mat.uniforms.uSpacing.value = uSpacing;
          mat.uniforms.uDetail.value = uDetail;
        }
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

// One full-width corridor floor: a quad strip from the right edge (+halfWidth) to the
// left edge (-halfWidth), flat at `surfaceY`. Every vertex carries its across-track
// distance from center (`aU`, signed), its along-track distance from the south end (`aV`),
// and the palette padded to 4 with a color count. The caret shader uses |aU|, so the
// chevron apex sits on the centerline and points north.
function buildFloor(
  frames: Frame[],
  along: number[],
  baseHalfW: number[],
  colors: string[],
  taper: [boolean, boolean],
): THREE.BufferGeometry {
  const { surfaceY } = NETWORK_STYLE.track;
  const w = taperFractions(frames, taper).map((fr, i) => baseHalfW[i] * fr);
  const pos: number[] = [];
  const uA: number[] = [];
  const vA: number[] = [];
  const push = (p: V3, u: number, v: number) => {
    pos.push(p.x, p.y, p.z);
    uA.push(u);
    vA.push(v);
  };
  for (let i = 0; i < frames.length - 1; i++) {
    const w0 = w[i];
    const w1 = w[i + 1];
    const ro0 = at(frames[i], w0, surfaceY);
    const lo0 = at(frames[i], -w0, surfaceY);
    const ro1 = at(frames[i + 1], w1, surfaceY);
    const lo1 = at(frames[i + 1], -w1, surfaceY);
    push(ro0, w0, along[i]);
    push(ro1, w1, along[i + 1]);
    push(lo0, -w0, along[i]);
    push(lo0, -w0, along[i]);
    push(ro1, w1, along[i + 1]);
    push(lo1, -w1, along[i + 1]);
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

// Per-frame taper fraction (0..1). 1 everywhere, except a merging end (baked `taper` flag)
// ramps from a narrow tip up to full width over the taper length, so the branch tucks under
// its trunk like a turnout instead of piling on full-width. See taperProfile for the
// short-segment and tip-floor guards. Multiplied by the per-frame base half-width.
function taperFractions(frames: Frame[], taper: [boolean, boolean]): number[] {
  const n = frames.length;
  if (!taper[0] && !taper[1]) return new Array(n).fill(1);
  const cum = [0];
  for (let i = 1; i < n; i++) {
    cum.push(
      cum[i - 1] +
        Math.hypot(
          frames[i].cx - frames[i - 1].cx,
          frames[i].cz - frames[i - 1].cz,
        ),
    );
  }
  return taperProfile(cum, taper, NETWORK_STYLE.track.taperLenM);
}

// Fuse a corridor's two antiparallel direction centerlines into one ribbon on their shared
// midline: for each frame of the owned direction, take the midpoint to the nearest point on
// the partner and a half-width that reaches both far walls (`halfWidth + gap/2`), so the fill
// spans exactly what the silhouette unions. Where the owned frame runs past the partner's
// extent (nearest point is a partner endpoint), there is no correspondence, so keep the plain
// half-width rather than bulging. The owned tangent's normal drives the cross-section.
function fuseFrames(
  owned: Frame[],
  partner: Frame[],
  halfWidth: number,
): { frames: Frame[]; halfW: number[] } {
  const frames: Frame[] = [];
  const halfW: number[] = [];
  for (const f of owned) {
    const q = nearestOnFrames(f.cx, f.cz, partner);
    if (q) {
      frames.push({ cx: (f.cx + q.x) / 2, cz: (f.cz + q.z) / 2, nx: f.nx, nz: f.nz });
      halfW.push(halfWidth + Math.hypot(f.cx - q.x, f.cz - q.z) / 2);
    } else {
      frames.push(f);
      halfW.push(halfWidth);
    }
  }
  return { frames, halfW };
}

// Nearest point on the partner polyline to (px, pz), or null when the closest approach is at a
// partner endpoint (the owned frame overhangs the partner's extent, so there is no true
// opposite-direction match to average with).
function nearestOnFrames(
  px: number,
  pz: number,
  frames: Frame[],
): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bd = Number.POSITIVE_INFINITY;
  let bClamped = true;
  for (let i = 0; i < frames.length - 1; i++) {
    const ax = frames[i].cx;
    const az = frames[i].cz;
    const dx = frames[i + 1].cx - ax;
    const dz = frames[i + 1].cz - az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((px - ax) * dx + (pz - az) * dz) / l2;
    const clamped = t < 0 || t > 1;
    t = Math.min(1, Math.max(0, t));
    const qx = ax + t * dx;
    const qz = az + t * dz;
    const d = (px - qx) ** 2 + (pz - qz) ** 2;
    if (d < bd) {
      bd = d;
      best = { x: qx, z: qz };
      bClamped = clamped;
    }
  }
  return bClamped ? null : best;
}

// Taper width fraction (0..1) at each vertex given cumulative arc length. A merging end ramps
// from TAPER_TIP_FRAC at the tip up to 1 over the taper length. Two guards keep short
// trunk-connectors (both ends flagged) from collapsing to a spindle: each end's ramp is
// capped to a fraction of the total so a full-width core always survives, and the tip never
// reaches zero width so its outline is a small cap the trunk swallows rather than a spike.
// Shared shape with build-silhouette's taperProfile — keep the two in sync.
const TAPER_TIP_FRAC = 0.12;
const TAPER_MAX_FRAC_BOTH = 0.4;
const TAPER_MAX_FRAC_ONE = 0.85;
function taperProfile(
  cum: number[],
  [tStart, tEnd]: [boolean, boolean],
  taperLenM: number,
): number[] {
  const total = cum[cum.length - 1] || 1;
  const cap = tStart && tEnd ? TAPER_MAX_FRAC_BOTH : TAPER_MAX_FRAC_ONE;
  const lStart = tStart ? Math.min(taperLenM, cap * total) : 0;
  const lEnd = tEnd ? Math.min(taperLenM, cap * total) : 0;
  const ramp = (d: number, l: number) => (l <= 0 ? 1 : Math.min(1, d / l));
  return cum.map((c) => {
    const f = Math.min(ramp(c, lStart), ramp(total - c, lEnd));
    return TAPER_TIP_FRAC + (1 - TAPER_TIP_FRAC) * f;
  });
}

// Platform edges from the baked silhouette (doc02.07): each ring is a closed loop of the
// dissolved outline; extrude every edge into a vertical curtain from the platform top
// (`surfaceY`) down by `wallHeight`, so the glowing side faces read as the raised
// platform's walls. Unlit/DoubleSide, so winding need not be tracked.
function buildSilhouetteWalls(
  silhouette: LngLat[][][],
  ctx: TrackContext,
  pos: number[],
  nor: number[],
) {
  const { surfaceY, wallHeight } = NETWORK_STYLE.track;
  const top = surfaceY;
  const bot = surfaceY - wallHeight;
  for (const poly of silhouette) {
    for (const ring of poly) {
      const pts = ring.map((p) => ctx.toLocal(p));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const aT = { x: a.x, y: top, z: a.z };
        const aB = { x: a.x, y: bot, z: a.z };
        const bT = { x: b.x, y: top, z: b.z };
        const bB = { x: b.x, y: bot, z: b.z };
        pushTri(pos, nor, aT, bT, aB);
        pushTri(pos, nor, aB, bT, bB);
      }
    }
  }
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
