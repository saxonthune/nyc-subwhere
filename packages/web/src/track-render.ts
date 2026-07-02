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
export type TrackGraph = {
  crossings: TrackCrossing[];
  elevation: number[][];
  partner: number[];
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

// One wide flat track per corridor (doc02.05). A corridor's two directions are fused
// into a single full-width ribbon (the partner segment is skipped), so there is no
// centerline seam to reason about — the median wall problem simply doesn't exist.
//   floor  — one full-width caret ribbon (-halfWidth..+halfWidth) on the corridor
//            centerline, lifted per-vertex by the baked crossing elevation.
//   walls  — only the two true outer edges; a curb piece is dropped where another
//            track's floor covers the point just outboard of it (an interior merge
//            edge). Crossings, at different baked grades, keep their walls.
// Floors merge into one caret-shader mesh with a face→segment map for picking; walls
// merge into one unlit grey mesh (not pickable — clicks fall through to the floor).
export class FlatTrackRenderer implements TrackRenderer {
  build(segments: TrackSegment[], graph: TrackGraph, ctx: TrackContext): TrackBuild {
    const { surfaceY } = NETWORK_STYLE.track;

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

    // Floor-coverage field for wall suppression: every corridor's floor area sampled
    // (across its width, at grade), so a wall piece can ask "does another track's floor
    // lie just beyond me?" — the mark of an interior (merge) edge to drop.
    const heights = new HeightGrid();
    built.forEach((b, si) => {
      if (b && owns(si)) addFloorSamples(b.frames, b.lift, si, heights);
    });

    const floors: { geo: THREE.BufferGeometry; seg: number }[] = [];
    const wallPos: number[] = [];
    const wallNor: number[] = [];
    built.forEach((b, si) => {
      if (!b || !owns(si)) return;
      const along = southOriginArcLength(b.frames);
      floors.push({
        geo: buildFloor(b.frames, along, segments[si].colors, b.lift),
        seg: si,
      });
      buildWalls(b.frames, b.lift, si, heights, wallPos, wallNor);
    });

    const objects: THREE.Object3D[] = [];
    const maps = new Map<THREE.Object3D, FaceMap>();

    if (wallPos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(wallPos, 3));
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

// A uniform grid of centerline samples (segment id + grade), so a wall piece can ask
// whether another track's ribbon covers a point at roughly its own height. Cell size
// exceeds the query radius, so a 3×3 cell scan finds every candidate.
class HeightGrid {
  private readonly cell = NETWORK_STYLE.track.halfWidth;
  private readonly map = new Map<string, { x: number; z: number; seg: number; g: number }[]>();

  add(x: number, z: number, seg: number, g: number) {
    const key = this.key(x, z);
    const bucket = this.map.get(key);
    if (bucket) bucket.push({ x, z, seg, g });
    else this.map.set(key, [{ x, z, seg, g }]);
  }

  // True if another segment's floor lies within `radius` of (x,z) at a grade within
  // `gradeEps` — i.e. there is same-height track covering this point just beyond a wall.
  covered(x: number, z: number, seg: number, g: number): boolean {
    const { wallSuppressFrac, wallGradeEpsM } = NETWORK_STYLE.track.junction;
    const radius = this.cell * wallSuppressFrac;
    const r2 = radius * radius;
    const gx = Math.floor(x / this.cell);
    const gz = Math.floor(z / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.map.get(`${gx + dx},${gz + dz}`);
        if (!bucket) continue;
        for (const s of bucket) {
          if (s.seg === seg) continue;
          if (Math.abs(s.g - g) > wallGradeEpsM) continue;
          const ex = x - s.x;
          const ez = z - s.z;
          if (ex * ex + ez * ez < r2) return true;
        }
      }
    }
    return false;
  }

  private key(x: number, z: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
}

// Tile a segment's floor into the height grid: samples along the centerline at
// ~sampleStepM and across the half-ribbon (center, mid, outer edge), each at its
// interpolated grade, so a wall's outboard point can test whether another floor covers
// it. Normals are interpolated (not renormalized) — placement, not exact metric.
function addFloorSamples(
  frames: Frame[],
  lift: number[],
  seg: number,
  grid: HeightGrid,
) {
  const { halfWidth, surfaceY } = NETWORK_STYLE.track;
  const step = NETWORK_STYLE.track.junction.sampleStepM;
  const across = [halfWidth, halfWidth / 2, 0, -halfWidth / 2, -halfWidth];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const len = Math.hypot(b.cx - a.cx, b.cz - a.cz) || 1;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const cx = a.cx + (b.cx - a.cx) * t;
      const cz = a.cz + (b.cz - a.cz) * t;
      const nx = a.nx + (b.nx - a.nx) * t;
      const nz = a.nz + (b.nz - a.nz) * t;
      const g = surfaceY + lift[i] + (lift[i + 1] - lift[i]) * t;
      for (const off of across) grid.add(cx + nx * off, cz + nz * off, seg, g);
    }
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
// left edge (-halfWidth), at `surfaceY` plus the per-vertex crossing lift. Every vertex
// carries its across-track distance from center (`aU`, signed), its along-track distance
// from the south end (`aV`), and the palette padded to 4 with a color count. The caret
// shader uses |aU|, so the chevron apex sits on the centerline and points north.
function buildFloor(
  frames: Frame[],
  along: number[],
  colors: string[],
  lift: number[],
): THREE.BufferGeometry {
  const { halfWidth, surfaceY } = NETWORK_STYLE.track;
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

// The two outer-edge curbs of a full-width corridor (at +halfWidth and -halfWidth). A
// piece is dropped where another track's floor covers the point just *outboard* of it at
// the same grade — the mark of an interior (merge) edge — so merges lose their facing
// walls and only the true outline is walled.
function buildWalls(
  frames: Frame[],
  lift: number[],
  seg: number,
  heights: HeightGrid,
  pos: number[],
  nor: number[],
) {
  const { halfWidth, surfaceY } = NETWORK_STYLE.track;
  const eps = NETWORK_STYLE.track.junction.wallOutboardM;
  for (const offset of [halfWidth, -halfWidth]) {
    const probe = offset + Math.sign(offset) * eps;
    for (let i = 0; i < frames.length - 1; i++) {
      const a = at(frames[i], probe, 0);
      const b = at(frames[i + 1], probe, 0);
      const g = surfaceY + (lift[i] + lift[i + 1]) / 2;
      if (heights.covered((a.x + b.x) / 2, (a.z + b.z) / 2, seg, g)) continue;
      curbPiece(frames[i], frames[i + 1], offset, lift[i], lift[i + 1], pos, nor);
    }
  }
}

// One straddling curb quad-strip between two frames at a given across-track offset:
// inner face, outer face, and a top cap, from the floor top to the wall top plus the
// per-end dome lift.
function curbPiece(
  fa: Frame,
  fb: Frame,
  offset: number,
  la: number,
  lb: number,
  pos: number[],
  nor: number[],
) {
  const { surfaceY, wallHeight, wallThickness } = NETWORK_STYLE.track;
  const t = wallThickness / 2;
  const floorTop = surfaceY;
  const wallTop = surfaceY + wallHeight;
  const aInF = at(fa, offset - t, floorTop + la);
  const aInT = at(fa, offset - t, wallTop + la);
  const aOutF = at(fa, offset + t, floorTop + la);
  const aOutT = at(fa, offset + t, wallTop + la);
  const bInF = at(fb, offset - t, floorTop + lb);
  const bInT = at(fb, offset - t, wallTop + lb);
  const bOutF = at(fb, offset + t, floorTop + lb);
  const bOutT = at(fb, offset + t, wallTop + lb);
  pushTri(pos, nor, aInF, bInF, aInT);
  pushTri(pos, nor, aInT, bInF, bInT);
  pushTri(pos, nor, aOutF, aOutT, bOutF);
  pushTri(pos, nor, bOutF, aOutT, bOutT);
  pushTri(pos, nor, aInT, bInT, aOutT);
  pushTri(pos, nor, aOutT, bInT, bOutT);
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
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r || 0, g || 0, b || 0];
}
