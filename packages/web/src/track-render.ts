import type { TrackFill, TrackGraph } from "@nyc-subwhere/contract";
import * as THREE from "three";
import { NETWORK_STYLE } from "./network-style";

// Re-export the baked graph type so NetworkLayer imports it from one place (it is produced by
// @nyc-subwhere/geometry and consumed here verbatim).
export type { TrackGraph } from "@nyc-subwhere/contract";

export type LngLat = [number, number];

// One baked corridor's palette source (doc01.03): the Route colors sharing this track. Parallel
// to segments.geojson, indexed by the fill's `segId`; the renderer expands it into the caret
// shader's per-vertex color attributes.
export type TrackSegment = { points: LngLat[]; colors: string[] };

// What the layer lends a renderer: the meter-frame projection it already owns. Keeps the
// renderer free of MapLibre/origin math.
export type TrackContext = {
  toLocal(p: LngLat): { x: number; z: number };
};

// The boundary (doc01.03): how the baked geometry becomes drawable 3D objects, and how a raycast
// hit reads back to a segment index. NetworkLayer knows only this.
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
  // Semantic-zoom LOD (doc01.03): the layer feeds the current zoom and ground meters-per-pixel
  // each time the map zooms, so the caret pattern stays legible in screen space.
  setZoom(zoom: number, metersPerPixel: number): void;
};

// The height of the highest part of the track (wall tops) — pucks and trains seat above this so
// they read as sitting on top of the track.
export function trackTopY(): number {
  return NETWORK_STYLE.track.surfaceY;
}

// A raised platform network (doc02.07), rendered entirely from baked geometry:
//   floor  — the baked caret fill (build-fill): triangles grouped by grade level, each carrying
//            along/across for the caret shader and a segId for palette + picking. One mesh per
//            level with a depth offset, so where floors overlap the higher grade wins the depth
//            test — junctions read without z-fighting, and because grade is draw order rather
//            than height, nothing bumps or floats.
//   walls  — the baked silhouette (build-silhouette): the boolean-union outline, each ring
//            extruded down from the platform top to ground as a glowing edge.
// Both derive from the SAME baked ribbon edges, so the fill reaches the wall by construction.
// The renderer computes no ribbon geometry: it uploads the fill and extrudes the outline.
export class FlatTrackRenderer implements TrackRenderer {
  build(
    segments: TrackSegment[],
    graph: TrackGraph,
    ctx: TrackContext,
  ): TrackBuild {
    // Platform edges (doc02.07): extrude each baked silhouette ring down from the platform top.
    const wallPos: number[] = [];
    const wallNor: number[] = [];
    buildSilhouetteWalls(graph.silhouette, ctx, wallPos, wallNor);

    const objects: THREE.Object3D[] = [];
    const segIdOf = new Map<THREE.Object3D, number[]>();

    if (wallPos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(wallPos, 3),
      );
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(wallNor, 3));
      // No userData.kind: walls are not pickable, so a click falls through to the floor.
      objects.push(new THREE.Mesh(geo, greyMaterial()));
    }

    // Caret floors: one mesh per baked grade level, with a depth offset so higher grades win
    // the depth test where floors overlap — crossings, merges, and near-parallel runs resolve
    // cleanly without lifting the geometry.
    const caretMats: THREE.ShaderMaterial[] = [];
    for (const group of graph.fill.groups) {
      const { mesh, mat, segId } = buildFillGroup(group, segments, ctx);
      caretMats.push(mat);
      mesh.userData.kind = "segment";
      objects.push(mesh);
      segIdOf.set(mesh, segId);
    }

    return {
      objects,
      // A triangle's three vertices come from one corridor, so any vertex's segId identifies it.
      segmentOfHit: (hit) => {
        const segId = segIdOf.get(hit.object);
        if (!segId || hit.faceIndex == null) return null;
        return segId[hit.faceIndex * 3] ?? null;
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

// One grade level's floor mesh from the baked fill group: project each [lng, lat] to the local
// meter frame at `surfaceY`, carry the baked along/across as the caret shader's aV/aU, and expand
// each vertex's segId into the palette attributes. The depth offset pulls higher grades toward
// the camera so a busier line drawn on top of what it crosses wins without any height difference.
function buildFillGroup(
  group: TrackFill["groups"][number],
  segments: TrackSegment[],
  ctx: TrackContext,
): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; segId: number[] } {
  const { surfaceY } = NETWORK_STYLE.track;
  const n = group.along.length;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { x, z } = ctx.toLocal([
      group.position[2 * i],
      group.position[2 * i + 1],
    ]);
    pos[3 * i] = x;
    pos[3 * i + 1] = surfaceY;
    pos[3 * i + 2] = z;
    nor[3 * i + 1] = 1; // flat +Y; the caret shader is unlit
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("aU", new THREE.Float32BufferAttribute(group.across, 1));
  geo.setAttribute("aV", new THREE.Float32BufferAttribute(group.along, 1));
  attachPalette(geo, group.segId, segments);

  const mat = caretMaterial();
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -group.level;
  mat.polygonOffsetUnits = -group.level * 4;
  const mesh = new THREE.Mesh(geo, mat);
  return { mesh, mat, segId: group.segId };
}

// Platform edges from the baked silhouette (doc02.07): each ring is a closed loop of the
// dissolved outline; extrude every edge into a vertical curtain from the platform top
// (`surfaceY`) down by `wallHeight`, so the glowing side faces read as the raised platform's
// walls. Unlit/DoubleSide, so winding need not be tracked.
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

// Expand each vertex's segId into up to four palette colors plus a count, so the merged floor
// mesh draws each corridor's own colors in the shader (max colors baked is 4, doc01.03). The
// palette comes from the owning segment — the same colors the map legend shows.
function attachPalette(
  geo: THREE.BufferGeometry,
  segId: number[],
  segments: TrackSegment[],
) {
  const n = segId.length;
  const cols = [
    new Float32Array(n * 3),
    new Float32Array(n * 3),
    new Float32Array(n * 3),
    new Float32Array(n * 3),
  ];
  const counts = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const colors = segments[segId[i]]?.colors ?? [];
    const rgb = colors.slice(0, 4).map(hexToRgb);
    while (rgb.length < 4) rgb.push(rgb[0] ?? [1, 1, 1]);
    for (let c = 0; c < 4; c++) {
      cols[c][3 * i] = rgb[c][0];
      cols[c][3 * i + 1] = rgb[c][1];
      cols[c][3 * i + 2] = rgb[c][2];
    }
    counts[i] = Math.max(1, Math.min(4, colors.length));
  }
  for (let c = 0; c < 4; c++)
    geo.setAttribute(`aCol${c}`, new THREE.BufferAttribute(cols[c], 3));
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

// The caret shader (doc01.03). One bent coordinate `g = along + |across|·tan(bendDeg)` partitions
// the ribbon into chevron cells: `floor(g/spacing)` picks the palette color and the black caret
// line falls where `g` crosses a cell boundary, so the "^" mark is exactly the seam between two
// colors — color and mark cannot drift apart. The apex sits on the centerline (across=0) and the
// arms trail south as |across| grows, so it points north. A shared trunk cycles its colors
// cell-to-cell. Unlit — the floor reads at full Route color like the trains. uSpacing (cell
// period) and uDetail (caret opacity) are driven per-zoom by setZoom for screen-space LOD.
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

// Parse "#rrggbb" straight to sRGB 0..1 floats. The caret shader writes gl_FragColor directly
// (no material color-management pass), so passing sRGB components paints the literal baked hex.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  return [r || 0, g || 0, b || 0];
}
