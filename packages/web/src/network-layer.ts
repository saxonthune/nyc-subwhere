import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NETWORK_STYLE } from "./network-style";
import type { TrainPose } from "./trains";

type LngLat = [number, number];
// colors is the truth from the baked corridor (doc01.03) — one entry for a solid
// trunk, several for a shared one that draws as a candy-cane tube.
type Segment = { points: LngLat[]; colors: string[] };

// Per-station placement in the meter-scaled local frame: offset from `origin`
// (X east, Z south) plus the track bearing at the station, as a rotation about
// the vertical axis so the platform box lies parallel to the track.
type Placement = { x: number; z: number; angleY: number };

// A single MapLibre custom layer that renders the whole static network in 3D in
// one shared Three.js scene (doc02.03): route lines as merged tubes, stations as
// an instanced "puck" disc above an instanced grey platform box oriented along
// the track. The puck fades out as the map zooms in, so close in the tubes read
// over the platform boxes with no puck occluding them.
//
// All meshes live in a meter-scaled local frame anchored at `origin`. MapLibre
// hands us a matrix each frame that maps Mercator coordinates → clip space; the
// local→Mercator transform (translate to origin, scale meters→Mercator, rotate
// Three's Y-up into map altitude) is composed onto it. This mirrors the canonical
// MapLibre + three.js custom-layer example: with rotateX(π/2) and a Y-flip, a
// mesh's local +Y becomes map altitude, local +X east, local +Z south.
export class NetworkLayer implements maplibregl.CustomLayerInterface {
  id = "network-3d";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private map!: maplibregl.Map;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private boxes?: THREE.InstancedMesh;
  private pucks?: THREE.InstancedMesh;
  private puckMaterial?: THREE.MeshStandardMaterial;
  private trains?: THREE.InstancedMesh;
  private trainGlow?: THREE.InstancedMesh;
  private trainCapacity = 0;

  private readonly origin = maplibregl.MercatorCoordinate.fromLngLat(
    [-73.98, 40.75],
    0,
  );
  private readonly meterScale = this.origin.meterInMercatorCoordinateUnits();
  private readonly placements: Placement[];
  private readonly segments: Segment[];

  constructor(stations: LngLat[], segments: Segment[]) {
    this.segments = segments;
    const lines = segments.map((s) => s.points);
    this.placements = stations.map((s) => this.place(s, bearingAt(s, lines)));
  }

  private toLocal(lngLat: LngLat): { x: number; z: number } {
    const m = maplibregl.MercatorCoordinate.fromLngLat(lngLat, 0);
    return {
      x: (m.x - this.origin.x) / this.meterScale,
      z: (m.y - this.origin.y) / this.meterScale,
    };
  }

  // Local-frame placement for a station: meter offset from origin + a rotation
  // about the vertical axis derived from the track bearing. rotationY maps local
  // +X (the box length axis) to (cosθ, 0, -sinθ); to align it with the local
  // track direction (east, south=-north), θ = atan2(north, east).
  private place(lngLat: LngLat, bearing: LngLat | null): Placement {
    const { x, z } = this.toLocal(lngLat);
    const angleY = bearing ? Math.atan2(bearing[1], bearing[0]) : 0;
    return { x, z, angleY };
  }

  onAdd(
    map: maplibregl.Map,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ) {
    this.map = map;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(0.5, 1, 0.3);
    this.scene.add(key);

    for (const mesh of this.buildTubes()) this.scene.add(mesh);
    this.pucks = this.buildPucks();
    this.boxes = this.buildBoxes();
    this.scene.add(this.pucks, this.boxes);

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;

    map.on("zoom", this.syncZoom);
    this.syncZoom();
  }

  onRemove() {
    this.map.off("zoom", this.syncZoom);
    this.renderer.dispose();
  }

  render(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrix: Parameters<maplibregl.CustomRenderMethod>[1],
  ) {
    const { origin, meterScale } = this;
    const rotateX = new THREE.Matrix4().makeRotationAxis(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );
    const local = new THREE.Matrix4()
      .makeTranslation(origin.x, origin.y, origin.z)
      .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
      .multiply(rotateX);

    const projection = new THREE.Matrix4().fromArray(matrix);
    this.camera.projectionMatrix = projection.multiply(local);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  }

  // One merged tube mesh per Route color (a handful of draw calls). Each segment
  // becomes a TubeGeometry along its centerline, riding at y=radius so its
  // underside rests on the ground plane above the platform boxes. A shared trunk
  // (colors.length > 1) is split into candy-cane bands, its triangles bucketed by
  // color, so every mesh still carries just one solid color.
  private buildTubes(): THREE.Mesh[] {
    const { tube } = NETWORK_STYLE;
    const byColor = new Map<string, THREE.BufferGeometry[]>();
    const push = (color: string, geo: THREE.BufferGeometry) => {
      const bucket = byColor.get(color);
      if (bucket) bucket.push(geo);
      else byColor.set(color, [geo]);
    };

    for (const seg of this.segments) {
      // CatmullRomCurve3 degenerates on repeated points (677/892 baked segments
      // carry consecutive duplicates); drop them so the frame stays defined.
      const pts = dedupeConsecutive(seg.points).map((p) => {
        const { x, z } = this.toLocal(p);
        return new THREE.Vector3(x, tube.radius, z);
      });
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts);
      const tubular = Math.min(400, Math.max(4, pts.length));
      const geo = new THREE.TubeGeometry(
        curve,
        tubular,
        tube.radius,
        tube.radialSegments,
        false,
      );

      if (seg.colors.length <= 1) {
        // Match the banded sub-geometries so a bucket merges cleanly: same
        // attributes (drop uv) and same form (non-indexed, since bandTube emits
        // non-indexed).
        geo.deleteAttribute("uv");
        const solid = geo.toNonIndexed();
        geo.dispose();
        push(seg.colors[0] ?? "#ffffff", solid);
        continue;
      }
      for (const [color, sub] of bandTube(
        geo,
        curve.getLength(),
        tubular,
        seg.colors,
      )) {
        push(color, sub);
      }
      geo.dispose();
    }

    const meshes: THREE.Mesh[] = [];
    for (const [color, geos] of byColor) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: tube.emissiveIntensity,
      });
      meshes.push(new THREE.Mesh(merged, mat));
    }
    return meshes;
  }

  private buildPucks(): THREE.InstancedMesh {
    const { puck } = NETWORK_STYLE;
    const geo = new THREE.CylinderGeometry(
      puck.radius,
      puck.radius,
      puck.height,
      24,
    );
    this.puckMaterial = new THREE.MeshStandardMaterial({
      color: puck.color,
      emissive: new THREE.Color(puck.emissive),
      emissiveIntensity: puck.emissiveIntensity,
      transparent: true,
    });
    const mesh = new THREE.InstancedMesh(
      geo,
      this.puckMaterial,
      this.placements.length,
    );
    // Seat the puck so its top clears the tube top (tube spans 0..2·radius).
    const centerY =
      2 * NETWORK_STYLE.tube.radius + puck.clearanceOverTube - puck.height / 2;
    const m = new THREE.Matrix4();
    this.placements.forEach((p, i) => {
      m.makeTranslation(p.x, centerY, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildBoxes(): THREE.InstancedMesh {
    const { box } = NETWORK_STYLE;
    // Local +X = length (along track), Y = depth (down), Z = width (across).
    const geo = new THREE.BoxGeometry(box.length, box.depth, box.width);
    const mat = new THREE.MeshStandardMaterial({ color: box.color });
    const mesh = new THREE.InstancedMesh(geo, mat, this.placements.length);
    const m = new THREE.Matrix4();
    this.placements.forEach((p, i) => {
      // Rotate flat about the vertical axis, then hang below ground: top face at
      // y=0, extending down by box.depth.
      m.makeRotationY(p.angleY);
      m.setPosition(p.x, -box.depth / 2, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  // Replace the live-train instances with the current frame's poses (doc02.04).
  // Called every animation frame by the interpolation loop in main.ts; the mesh
  // is grown lazily as the fleet size climbs. Each train is one elongated box,
  // rotated flat about the vertical axis so its length runs along its travel
  // bearing (same X=east, Z=south convention as the platform boxes).
  setTrains(poses: TrainPose[]) {
    if (!this.trains || !this.trainGlow || poses.length > this.trainCapacity) {
      this.rebuildTrains(Math.max(64, poses.length));
    }
    const core = this.trains;
    const glow = this.trainGlow;
    if (!core || !glow) return;

    const centerY = trainCenterY();
    const rot = new THREE.Matrix4();
    const pos = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    poses.forEach((p, i) => {
      const { x, z } = this.toLocal(p.lngLat);
      rot.makeRotationY(p.bearing);
      pos.makeTranslation(x, centerY, z);
      m.multiplyMatrices(pos, rot);
      // The glow box is pre-scaled in geometry, so the same transform drives both.
      core.setMatrixAt(i, m);
      glow.setMatrixAt(i, m);
      color.set(p.color);
      core.setColorAt(i, color);
      glow.setColorAt(i, color);
    });
    core.count = poses.length;
    glow.count = poses.length;
    core.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
    if (core.instanceColor) core.instanceColor.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  }

  private rebuildTrains(capacity: number) {
    for (const old of [this.trains, this.trainGlow]) {
      if (!old) continue;
      this.scene.remove(old);
      old.geometry.dispose();
    }
    const { train } = NETWORK_STYLE;

    // Core: a solid, fully self-lit box (unlit MeshBasic) so the train reads at
    // full Route color against the dimmer, shaded tubes below it. Local +X =
    // length (along travel), Y = height, Z = width (across). setColorAt tints
    // each instance, so one material carries every Route color.
    const coreGeo = new THREE.BoxGeometry(
      train.length,
      train.height,
      train.width,
    );
    const core = new THREE.InstancedMesh(
      coreGeo,
      new THREE.MeshBasicMaterial(),
      capacity,
    );
    core.frustumCulled = false;

    // Glow: a larger additive-blended shell around the core. On the black
    // background additive blending fakes a cheap bloom halo, lifting the train
    // clear of the line it rides. depthWrite off so it never occludes.
    const g = train.glow;
    const glowGeo = new THREE.BoxGeometry(
      train.length * g.scaleLength,
      train.height * g.scaleCross,
      train.width * g.scaleCross,
    );
    const glow = new THREE.InstancedMesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: g.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      capacity,
    );
    glow.frustumCulled = false;
    glow.renderOrder = 1;

    this.trains = core;
    this.trainGlow = glow;
    this.trainCapacity = capacity;
    this.scene.add(glow, core);
  }

  private syncZoom = () => {
    const zoom = this.map.getZoom();
    if (this.boxes) this.boxes.visible = zoom >= NETWORK_STYLE.box.minZoom;

    const { fadeStartZoom, fadeEndZoom } = NETWORK_STYLE.puck;
    const t = (zoom - fadeStartZoom) / (fadeEndZoom - fadeStartZoom);
    const opacity = 1 - Math.min(1, Math.max(0, t));
    if (this.puckMaterial) this.puckMaterial.opacity = opacity;
    if (this.pucks) this.pucks.visible = opacity > 0;
  };
}

// Train underside rests `train.clearance` above the puck top, which itself sits
// `puck.clearanceOverTube` above the tube top (2·tube.radius) — so trains read as
// sitting on top of both the tubes and the pucks.
function trainCenterY(): number {
  const { tube, puck, train } = NETWORK_STYLE;
  const puckTop = 2 * tube.radius + puck.clearanceOverTube;
  return puckTop + train.clearance + train.height / 2;
}

// The unit track direction (east, north components) nearest to a station, found
// by the closest vertex across all segments and the direction to its neighbor.
// Stations sit on track vertices, so the nearest vertex is effectively the
// station's own point on its line. Returns null if no segment has an edge.
function bearingAt(station: LngLat, lines: LngLat[][]): LngLat | null {
  let best = Number.POSITIVE_INFINITY;
  let dir: LngLat | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const d = sqDist(station, line[i]);
      if (d >= best) continue;
      const neighbor = line[i + 1] ?? line[i - 1];
      if (!neighbor) continue;
      best = d;
      const cosLat = Math.cos((station[1] * Math.PI) / 180);
      const east = (neighbor[0] - line[i][0]) * cosLat;
      const north = neighbor[1] - line[i][1];
      const len = Math.hypot(east, north) || 1;
      dir = [east / len, north / len];
    }
  }
  return dir;
}

function sqDist(a: LngLat, b: LngLat): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function dedupeConsecutive(points: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

// Split a tube into candy-cane color bands. TubeGeometry lays vertices out as
// (tubular+1) rings of (radialSegments+1) verts; index i is the ring (arc
// position), j the angle around the tube. Each triangle is assigned to the color
// of its centroid band, where band position s = ring + slant·cos(angle): the
// cosine term advances the cut on one flank and retreats it on the other, so the
// boundary is a slanted plane (the penne look) rather than a flat ring. Returns
// one non-indexed geometry (position + normal) per color present.
function bandTube(
  geo: THREE.BufferGeometry,
  length: number,
  tubular: number,
  colors: string[],
): Array<[string, THREE.BufferGeometry]> {
  const { candy, radialSegments } = NETWORK_STYLE.tube;
  const ringSpacing = length / tubular; // meters advanced per ring step
  const bandRings = Math.max(1, candy.bandLengthM / ringSpacing);
  const slantRings = candy.slantM / ringSpacing;
  const ring = radialSegments + 1;

  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const index = geo.getIndex();
  if (!index) return [];

  const sOf = (idx: number): number => {
    const i = Math.floor(idx / ring);
    const j = idx % ring;
    return i + slantRings * Math.cos((2 * Math.PI * j) / radialSegments);
  };
  const bandColor = (s: number): string => {
    const n = colors.length;
    return colors[((Math.floor(s / bandRings) % n) + n) % n];
  };

  const buckets = new Map<string, { p: number[]; n: number[] }>();
  const arr = index.array;
  for (let t = 0; t < arr.length; t += 3) {
    const tri = [arr[t], arr[t + 1], arr[t + 2]];
    const s = (sOf(tri[0]) + sOf(tri[1]) + sOf(tri[2])) / 3;
    const color = bandColor(s);
    let bucket = buckets.get(color);
    if (!bucket) {
      bucket = { p: [], n: [] };
      buckets.set(color, bucket);
    }
    for (const idx of tri) {
      bucket.p.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
      bucket.n.push(nor.getX(idx), nor.getY(idx), nor.getZ(idx));
    }
  }

  const out: Array<[string, THREE.BufferGeometry]> = [];
  for (const [color, { p, n }] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
    out.push([color, g]);
  }
  return out;
}
