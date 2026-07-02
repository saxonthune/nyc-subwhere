import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NETWORK_STYLE } from "./network-style";

export type LngLat = [number, number];

// One baked corridor (doc01.03): a polyline plus the truth of which Route colors
// share it — one entry for a solid trunk, several for a shared one.
export type TrackSegment = { points: LngLat[]; colors: string[] };

// What the layer lends a renderer: the meter-frame projection it already owns.
// Keeps the renderer free of MapLibre/origin math.
export type TrackContext = {
  toLocal(p: LngLat): { x: number; z: number };
};

// The boundary (doc01.03): how a corridor set becomes drawable 3D objects, and how
// a raycast hit on those objects reads back to a segment index. NetworkLayer knows
// only this — swap the implementation to change how track looks without touching
// the layer, picking, or the rest of the scene.
export interface TrackRenderer {
  build(segments: TrackSegment[], ctx: TrackContext): TrackBuild;
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

// Tubes → one wide flat track (doc01.03). A corridor's two direction polylines run
// along the same centerline; each is drawn as a half-ribbon offset to its own left,
// so the two together tile one wide colored floor with a grey wall + wing only on
// each outer edge (no wall down the median). The floor carries caret marks — a
// single pair of 30° black line segments pointing toward the corridor's north end,
// repeating along the track; a shared trunk cycles its colors caret-to-caret. Both
// halves index their along-track position from the corridor's south end, so their
// carets stay in phase and meet at the centerline. Floors merge into one shader
// mesh and grey structure into one standard mesh; each keeps a face→segment map.
export class FlatTrackRenderer implements TrackRenderer {
  build(segments: TrackSegment[], ctx: TrackContext): TrackBuild {
    type Entry = { geo: THREE.BufferGeometry; seg: number };
    const floors: Entry[] = [];
    const greys: Entry[] = [];

    segments.forEach((seg, si) => {
      // CatmullRom-free: build straight from the polyline. Consecutive duplicates
      // (common in the baked geometry) would give a zero tangent, so drop them.
      const pts = dedupeConsecutive(seg.points).map((p) => ctx.toLocal(p));
      if (pts.length < 2) return;
      const frames = framesOf(pts);
      const along = southOriginArcLength(pts);
      floors.push({ geo: buildFloor(frames, along, seg.colors), seg: si });
      greys.push({ geo: buildGrey(frames), seg: si });
    });

    const objects: THREE.Object3D[] = [];
    const maps = new Map<THREE.Object3D, FaceMap>();

    const greyMesh = mergeEntries(greys, greyMaterial());
    if (greyMesh) {
      greyMesh.mesh.userData.kind = "segment";
      objects.push(greyMesh.mesh);
      maps.set(greyMesh.mesh, greyMesh.faceMap);
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
        // Cell period is the larger of the base meters and a screen-space floor, so
        // zoomed out the bands coarsen instead of aliasing sub-pixel.
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
// triangle count gives each entry its face range in the merged mesh — the same
// mapping the tube renderer used.
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
// median (`medianGap` from center) out to the full half-width. Every vertex carries
// its across-track distance from the corridor center (`aU`, for the caret arms), its
// along-track distance from the south end (`aV`, for the caret repeat and color
// bands), and the whole segment palette padded to 4 with a color count.
function buildFloor(
  frames: Frame[],
  along: number[],
  colors: string[],
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
    const li0 = at(frames[i], -medianGap, surfaceY);
    const lo0 = at(frames[i], -halfWidth, surfaceY);
    const li1 = at(frames[i + 1], -medianGap, surfaceY);
    const lo1 = at(frames[i + 1], -halfWidth, surfaceY);
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

// The grey structure for one half-ribbon: a wall standing up on the outer edge and
// a wing flanging out past it. No inner (median) wall — the two halves read as one
// wide track. DoubleSide material dodges per-side winding.
function buildGrey(frames: Frame[]): THREE.BufferGeometry {
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
  sweep(frames, pos, nor, -outer, floorTopY, -outer, wallTopY); // wall inner face
  sweep(frames, pos, nor, -outer, wallTopY, -wallOuter, wallTopY); // wall top
  sweep(frames, pos, nor, -wallOuter, wallTopY, -wallOuter, wingTopY); // wall outer
  sweep(frames, pos, nor, -wallOuter, wingTopY, -wingOuter, wingTopY); // wing top
  sweep(frames, pos, nor, -wingOuter, wingTopY, -wingOuter, floorTopY); // wing outer

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

// A quad strip along the centerline between two profile edges, each edge given by
// an across-track offset and a height. Face normals are flat per triangle.
function sweep(
  frames: Frame[],
  pos: number[],
  nor: number[],
  aOff: number,
  aY: number,
  bOff: number,
  bY: number,
) {
  for (let i = 0; i < frames.length - 1; i++) {
    const a0 = at(frames[i], aOff, aY);
    const a1 = at(frames[i + 1], aOff, aY);
    const b0 = at(frames[i], bOff, bY);
    const b1 = at(frames[i + 1], bOff, bY);
    pushTri(pos, nor, a0, a1, b0);
    pushTri(pos, nor, b0, a1, b1);
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
function framesOf(pts: { x: number; z: number }[]): Frame[] {
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
function southOriginArcLength(pts: { x: number; z: number }[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const startIsSouth = pts[0].z >= pts[pts.length - 1].z;
  const total = cum[cum.length - 1];
  return startIsSouth ? cum : cum.map((c) => total - c);
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
