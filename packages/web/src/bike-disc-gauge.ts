import * as THREE from "three";
import type { BikeResourceCounts } from "./bike-scoreboard";
import { NETWORK_STYLE } from "./network-style";

const DEG2RAD = Math.PI / 180;

// Bike View dock markers, "gauge" mode: the white disc stays as the base (the
// existing instanced mesh, still the pick proxy), and each resource sector is
// a real extruded arc piece bulging slightly out of the disc top — one sector
// per resource, adding rings as stock crosses that sector's thresholds.
// Sectors are world-aligned (the Manhattan grid bearing is baked into their
// arc angles), never camera-relative.
//
// Only the sector shapes vary, not the docks: with S slices of R rings there
// are S×R distinct geometries, so the citywide display is one InstancedMesh
// per (slice, ring) pair — a handful of draw calls total, no textures. Each
// dock contributes an instance to a ring's mesh only while its count clears
// that ring's threshold, so the whole thing rebuilds cheaply on every push.
//
// The meshes live on a dedicated render layer (network-layer.ts draws it in a
// separate pass after the bloom composites), so the white disc's glow never
// washes over the sector colors.
export class BikeDiscGauges {
  readonly group = new THREE.Group();
  private readonly geometries: THREE.ExtrudeGeometry[] = [];
  private readonly topMaterial: THREE.MeshBasicMaterial;
  private readonly sideMaterial: THREE.MeshBasicMaterial;

  constructor(
    placements: { x: number; z: number }[],
    counts: (BikeResourceCounts | null)[],
    discTopY: number,
    depthOffset: [number, number],
    layer: number,
  ) {
    const st = NETWORK_STYLE.bikeView.bikeStation;
    const g = st.gauge;
    const R = st.radius;
    const halfGap = (g.rings.sectorGapFrac * R) / 2;
    // Instance colors carry the slice color (and the depleted dim), so both
    // materials stay white/grey multipliers shared by every mesh. The side
    // material's grey fakes shading — these are unlit materials, and a darker
    // wall is what makes the bulge read as relief.
    this.topMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.sideMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setScalar(g.sideShade),
    });
    for (const mat of [this.topMaterial, this.sideMaterial]) {
      mat.polygonOffset = true;
      [mat.polygonOffsetFactor, mat.polygonOffsetUnits] = depthOffset;
    }

    const baseY = discTopY - g.relief.embed;
    const color = new THREE.Color();
    const m = new THREE.Matrix4();
    for (const slice of g.slices) {
      const bands = slice.ringThresholds.length;
      const band =
        (g.rings.outerFrac -
          g.rings.innerFrac -
          g.rings.gapFrac * (bands - 1)) /
        bands;
      // Bake the grid rotation into the sector's bearings.
      const grid = NETWORK_STYLE.bikeView.gridBearingDeg;
      const b0 = slice.centerDeg - slice.spanDeg / 2 + grid;
      const b1 = slice.centerDeg + slice.spanDeg / 2 + grid;
      color.set(slice.color);
      slice.ringThresholds.forEach((min, ring) => {
        const r0 = (g.rings.innerFrac + ring * (band + g.rings.gapFrac)) * R;
        const r1 = r0 + band * R;
        const geo = sectorGeometry(b0, b1, r0, r1, halfGap, g.relief);
        const mesh = new THREE.InstancedMesh(
          geo,
          [this.topMaterial, this.sideMaterial],
          placements.length,
        );
        let n = 0;
        placements.forEach((p, i) => {
          const c = counts[i];
          if (!c || c[slice.key] < min) return;
          m.makeTranslation(p.x, baseY, p.z);
          mesh.setMatrixAt(n, m);
          // Full color always: a depleted dock greys out only its disc base
          // (network-layer.ts), never the sectors that still have stock.
          mesh.setColorAt(n, color);
          n++;
        });
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.frustumCulled = false;
        mesh.layers.set(layer);
        this.group.add(mesh);
        this.geometries.push(geo);
      });
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const geo of this.geometries) geo.dispose();
    this.topMaterial.dispose();
    this.sideMaterial.dispose();
  }
}

// One ring segment of one sector, extruded flat-to-up. Bearings (compass
// degrees) become shape angles by α = 90° − β (shape x = east, y = north;
// rotateX(-90°) then lays y onto north with the extrusion running up). The
// white channel between sectors has a constant linear width: each radius gets
// its own angular inset, asin(halfGap / r), putting every arc endpoint at
// perpendicular distance halfGap from the sector's boundary line so the
// straight edges joining the arcs run parallel to it.
function sectorGeometry(
  b0deg: number,
  b1deg: number,
  r0: number,
  r1: number,
  halfGap: number,
  relief: { height: number; bevel: number },
): THREE.ExtrudeGeometry {
  const alpha = (bearing: number) => Math.PI / 2 - bearing;
  const beta0 = b0deg * DEG2RAD;
  const beta1 = b1deg * DEG2RAD;
  const in0 = Math.asin(Math.min(1, halfGap / r0));
  const in1 = Math.asin(Math.min(1, halfGap / r1));
  const shape = new THREE.Shape();
  shape.absarc(0, 0, r1, alpha(beta0 + in1), alpha(beta1 - in1), true);
  shape.absarc(0, 0, r0, alpha(beta1 - in0), alpha(beta0 + in0), false);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: relief.height,
    bevelEnabled: true,
    bevelThickness: relief.bevel,
    bevelSize: relief.bevel,
    bevelSegments: 2,
    curveSegments: 24,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}
