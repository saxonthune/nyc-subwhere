import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NETWORK_STYLE } from "./network-style";
import { type GlowEffect, cameraDirLocal, createGlow } from "./train-glow";
import type { TrainPose } from "./trains";

// three.js render layer the train boxes also live on, so the bloom effect can
// render just the trains by restricting the camera to it (doc02.03).
const TRAIN_LAYER = 1;

type LngLat = [number, number];
// colors is the truth from the baked corridor (doc01.03) — one entry for a solid
// trunk, several for a shared one that draws as a candy-cane tube.
type Segment = { points: LngLat[]; colors: string[] };
// One baked borough polygon (doc01.03 Basemap): rings[0] is the outer boundary,
// any further rings are holes.
export type BoroughPolygon = LngLat[][];

// Per-station placement in the meter-scaled local frame: offset from `origin`
// (X east, Z south) plus the track bearing at the station, as a rotation about
// the vertical axis so the platform box lies parallel to the track.
type Placement = { x: number; z: number; angleY: number };

// A geometric hit, resolved to the index/id the caller keyed its metadata by
// (doc01.03). This layer stays free of Trip/Station semantics: main.ts turns a
// PickResult into an inspector target from its own baked props + live snapshot.
export type PickResult =
  | { kind: "segment"; segmentIndex: number }
  | { kind: "station"; stationIndex: number }
  | { kind: "train"; tripId: string };

// Tubes for one color are merged into a single non-indexed mesh, so a raycast
// hit gives a faceIndex, not a segment. This maps face ranges back: triStart[i]
// is the first triangle of segIds[i]'s slice within the merged geometry.
type FaceMap = { triStart: number[]; segIds: number[] };

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
  private waterTexture?: THREE.Texture;
  private trains?: THREE.InstancedMesh;
  private readonly glow: GlowEffect = createGlow();
  private trainCapacity = 0;
  // Packed per-frame train draw data handed to the glow effect (train-glow.ts),
  // grown with the core mesh so no per-frame allocation is needed.
  private glowPositions = new Float32Array(0);
  private glowBearings = new Float32Array(0);
  private glowColors = new Float32Array(0);
  private tubeMeshes: THREE.Mesh[] = [];
  private currentPoses: TrainPose[] = [];
  private trainsVisible = true;
  private readonly raycaster = new THREE.Raycaster();

  private readonly origin = maplibregl.MercatorCoordinate.fromLngLat(
    [-73.98, 40.75],
    0,
  );
  private readonly meterScale = this.origin.meterInMercatorCoordinateUnits();
  private readonly placements: Placement[];
  private readonly segments: Segment[];
  private readonly boroughs: BoroughPolygon[];

  constructor(
    stations: LngLat[],
    segments: Segment[],
    boroughs: BoroughPolygon[] = [],
  ) {
    this.segments = segments;
    this.boroughs = boroughs;
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

    // Basemap first (doc01.03): water plane at the bottom, grey borough land above
    // it, both beneath the network. They carry no userData.kind, so pick() never
    // sees them and clicks pass through to the tracks and stations.
    this.scene.add(this.buildWater());
    const land = this.buildLand();
    if (land) this.scene.add(land);

    this.tubeMeshes = this.buildTubes();
    for (const mesh of this.tubeMeshes) this.scene.add(mesh);
    this.pucks = this.buildPucks();
    this.boxes = this.buildBoxes();
    this.pucks.userData.kind = "station";
    this.boxes.userData.kind = "station";
    this.scene.add(this.pucks, this.boxes);

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
    this.glow.onAdd(this.renderer, this.scene);

    map.on("zoom", this.syncZoom);
    this.syncZoom();
  }

  onRemove() {
    this.map.off("zoom", this.syncZoom);
    this.glow.dispose();
    this.waterTexture?.dispose();
    this.renderer.dispose();
  }

  // Raycast the scene at a screen point (doc01.03). The camera's projectionMatrix
  // already folds in the local->clip transform render() composes each frame, so
  // its inverse maps a clip-space near/far pair straight into the mesh's meter
  // frame — no view matrix to undo. Nearest hit wins; invisible meshes (a puck
  // faded out at high zoom, a box hidden when zoomed out) are skipped by three.
  pick(point: { x: number; y: number }): PickResult | null {
    const canvas = this.map.getCanvas();
    const ndcX = (point.x / canvas.clientWidth) * 2 - 1;
    const ndcY = -(point.y / canvas.clientHeight) * 2 + 1;
    const inv = this.camera.projectionMatrix.clone().invert();
    const near = new THREE.Vector3(ndcX, ndcY, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(ndcX, ndcY, 1).applyMatrix4(inv);
    this.raycaster.set(near, far.sub(near).normalize());

    const targets: THREE.Object3D[] = [...this.tubeMeshes];
    if (this.pucks) targets.push(this.pucks);
    if (this.boxes) targets.push(this.boxes);
    if (this.trains) targets.push(this.trains);

    for (const hit of this.raycaster.intersectObjects(targets, false)) {
      const kind = hit.object.userData.kind;
      if (kind === "train" && hit.instanceId != null) {
        const pose = this.currentPoses[hit.instanceId];
        if (pose) return { kind: "train", tripId: pose.tripId };
      } else if (kind === "station" && hit.instanceId != null) {
        return { kind: "station", stationIndex: hit.instanceId };
      } else if (kind === "segment" && hit.faceIndex != null) {
        const seg = segmentOfFace(hit.object.userData.faceMap, hit.faceIndex);
        if (seg != null) return { kind: "segment", segmentIndex: seg };
      }
    }
    return null;
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
    this.glow.render(
      () => this.renderer.render(this.scene, this.camera),
      () => {
        // Bloom source: restrict the camera to the train layer so only the train
        // boxes render, then restore the default layer for the next full pass.
        this.camera.layers.set(TRAIN_LAYER);
        this.renderer.render(this.scene, this.camera);
        this.camera.layers.set(0);
      },
    );
    this.map.triggerRepaint();
  }

  // One merged tube mesh per Route color (a handful of draw calls). Each segment
  // becomes a TubeGeometry along its centerline, riding at y=radius so its
  // underside rests on the ground plane above the platform boxes. A shared trunk
  // (colors.length > 1) is split into candy-cane bands, its triangles bucketed by
  // color, so every mesh still carries just one solid color.
  private buildTubes(): THREE.Mesh[] {
    const { tube } = NETWORK_STYLE;
    // Each entry keeps its owning segment index so the merged mesh can map a
    // raycast faceIndex back to a segment for the inspector (doc01.03).
    type Entry = { geo: THREE.BufferGeometry; seg: number };
    const byColor = new Map<string, Entry[]>();
    const push = (color: string, geo: THREE.BufferGeometry, seg: number) => {
      const bucket = byColor.get(color);
      if (bucket) bucket.push({ geo, seg });
      else byColor.set(color, [{ geo, seg }]);
    };

    this.segments.forEach((seg, si) => {
      // CatmullRomCurve3 degenerates on repeated points (677/892 baked segments
      // carry consecutive duplicates); drop them so the frame stays defined.
      const local = dedupeConsecutive(seg.points).map((p) => this.toLocal(p));
      if (local.length < 2) return;
      const pts = offsetLeft(local, tube.sideOffsetM).map(
        ({ x, z }) => new THREE.Vector3(x, tube.radius, z),
      );
      const curve = new THREE.CatmullRomCurve3(pts);
      // Rings spaced a fixed arc-length apart (getPointAt is arc-length
      // parameterized), so ring density — and thus band size — is uniform across
      // every segment regardless of its baked vertex count.
      const length = curve.getLength();
      const tubular = Math.min(
        400,
        Math.max(8, Math.round(length / tube.ringLengthM)),
      );
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
        push(seg.colors[0] ?? "#ffffff", solid, si);
        return;
      }
      for (const [color, sub] of bandTube(geo, length, tubular, seg.colors)) {
        push(color, sub, si);
      }
      geo.dispose();
    });

    const meshes: THREE.Mesh[] = [];
    for (const [color, entries] of byColor) {
      // mergeGeometries concatenates in push order (useGroups=false), so the
      // running triangle count gives each entry's face range in the merged mesh.
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
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: tube.emissiveIntensity,
      });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.userData.kind = "segment";
      mesh.userData.faceMap = faceMap;
      meshes.push(mesh);
    }
    return meshes;
  }

  // A dark-navy disc surrounding the city, seated a little below ground level so
  // the borough land stands out of it at the shoreline (doc01.03 Basemap). A radial
  // gradient texture keeps the core solid navy, then fades it to transparent by the
  // rim so the water dissolves into the black background with no hard edge.
  // depthWrite off and renderOrder below everything so it never occludes the network.
  // frustumCulled off: it is large and centered on the origin, and this layer drives
  // the camera directly, so three's default cull can wrongly reject it.
  private buildWater(): THREE.Mesh {
    const { water } = NETWORK_STYLE;
    const geo = new THREE.CircleGeometry(water.radius, 96);
    geo.rotateX(-Math.PI / 2); // lay the disc flat in the XZ ground plane
    this.waterTexture = makeWaterTexture(water.color, water.coreFraction);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: this.waterTexture,
        transparent: true,
        depthWrite: false,
      }),
    );
    mesh.position.y = water.level;
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return mesh;
  }

  // The five boroughs as one merged grey mesh, each polygon extruded downward from
  // ground level (doc01.03 Basemap). A borough ring becomes a THREE.Shape in the
  // local frame with holes; ExtrudeGeometry triangulates and extrudes it along +Z,
  // and rotateX(-90°) lays that on the ground so the extrude runs up in +Y. The
  // shape's Y is negated because that rotation flips local south, and the whole
  // mesh drops by `height` so its top face sits at y=0 — the ground the tubes ride.
  private buildLand(): THREE.Mesh | null {
    const { land } = NETWORK_STYLE;
    const toShapePoint = (p: LngLat): THREE.Vector2 => {
      const { x, z } = this.toLocal(p);
      return new THREE.Vector2(x, -z);
    };
    const geos: THREE.BufferGeometry[] = [];
    for (const rings of this.boroughs) {
      const [outer, ...holes] = rings;
      if (!outer || outer.length < 3) continue;
      const shape = new THREE.Shape(outer.map(toShapePoint));
      for (const hole of holes) {
        if (hole.length >= 3)
          shape.holes.push(new THREE.Path(hole.map(toShapePoint)));
      }
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: land.height,
        bevelEnabled: false,
      });
      geo.rotateX(-Math.PI / 2);
      geos.push(geo);
    }
    if (geos.length === 0) return null;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(
      merged,
      // DoubleSide so the top face reads lit regardless of the extrude's winding.
      new THREE.MeshStandardMaterial({
        color: land.color,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.y = -land.height;
    mesh.frustumCulled = false;
    return mesh;
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
    if (!this.trains || poses.length > this.trainCapacity) {
      this.rebuildTrains(Math.max(64, poses.length));
    }
    this.currentPoses = poses;
    const core = this.trains;
    if (!core) return;

    const centerY = trainCenterY();
    const off = NETWORK_STYLE.tube.sideOffsetM;
    const rot = new THREE.Matrix4();
    const pos = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    poses.forEach((p, i) => {
      const c = this.toLocal(p.lngLat);
      // Shift onto the same right-of-travel side as the tube (offsetLeft in the
      // flipped local frame): perpendicular (sin, cos) of the travel bearing, so
      // the train rides its own track instead of floating on the centerline.
      const x = c.x + Math.sin(p.bearing) * off;
      const z = c.z + Math.cos(p.bearing) * off;
      rot.makeRotationY(p.bearing);
      pos.makeTranslation(x, centerY, z);
      m.multiplyMatrices(pos, rot);
      core.setMatrixAt(i, m);
      color.set(p.color);
      core.setColorAt(i, color);

      this.glowPositions[3 * i] = x;
      this.glowPositions[3 * i + 1] = centerY;
      this.glowPositions[3 * i + 2] = z;
      this.glowBearings[i] = p.bearing;
      this.glowColors[3 * i] = color.r;
      this.glowColors[3 * i + 1] = color.g;
      this.glowColors[3 * i + 2] = color.b;
    });
    core.count = poses.length;
    core.instanceMatrix.needsUpdate = true;
    if (core.instanceColor) core.instanceColor.needsUpdate = true;
    // A rebuild (capacity growth) makes a fresh, visible mesh, so re-apply the
    // toggle here rather than only in toggleTrains.
    core.visible = this.trainsVisible;

    // Camera direction (toward the viewer) in the local frame, from the map's
    // pitch/bearing — this layer sets projectionMatrix directly, so there is no
    // three camera to read it from. Local frame: +X east, +Y up, +Z south.
    const camDir = cameraDirLocal(this.map.getPitch(), this.map.getBearing());
    this.glow.update(
      {
        count: poses.length,
        positions: this.glowPositions,
        bearings: this.glowBearings,
        colors: this.glowColors,
      },
      camDir,
    );
  }

  // Hide/show live trains without dropping the poll+interpolate loop (doc01.03).
  // Not persisted: a reload starts with trains shown.
  toggleTrains(): void {
    this.trainsVisible = !this.trainsVisible;
    if (this.trains) this.trains.visible = this.trainsVisible;
    this.glow.setVisible(this.trainsVisible);
  }

  private rebuildTrains(capacity: number) {
    if (this.trains) {
      this.scene.remove(this.trains);
      this.trains.geometry.dispose();
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
    core.userData.kind = "train";
    // Also on the train layer so the bloom effect can render it in isolation.
    core.layers.enable(TRAIN_LAYER);

    this.trains = core;
    this.trainCapacity = capacity;
    this.glowPositions = new Float32Array(capacity * 3);
    this.glowBearings = new Float32Array(capacity);
    this.glowColors = new Float32Array(capacity * 3);
    this.glow.rebuild(capacity);
    this.scene.add(core);
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

// A radial gradient for the water disc: solid navy out to `coreFraction` of the
// radius, then easing to transparent at the rim so the disc melts into the black
// background. CircleGeometry's UVs put the disc center at texture center, so the
// gradient maps straight onto it.
function makeWaterTexture(color: string, coreFraction: number): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  const c = new THREE.Color(color);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(coreFraction, `rgba(${rgb},1)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// Largest triStart[i] <= faceIndex gives the segment owning that triangle.
function segmentOfFace(
  map: FaceMap | undefined,
  faceIndex: number,
): number | null {
  if (!map) return null;
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

// Shift every vertex `d` meters to the left of the local travel direction (the
// central-difference tangent), in the meter-scaled local frame. Antiparallel N/S
// shapes get opposite tangents, so the same shift separates them.
function offsetLeft(
  pts: { x: number; z: number }[],
  d: number,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const len = Math.hypot(tx, tz) || 1;
    // Left-hand perpendicular (-tz, tx) of the unit tangent.
    out.push({ x: pts[i].x + (-tz / len) * d, z: pts[i].z + (tx / len) * d });
  }
  return out;
}

// Split a tube into candy-cane color bands. TubeGeometry lays vertices out as
// (tubular+1) rings of (radialSegments+1) verts; ring = floor(idx/ring). Rings are
// equally spaced in arc length, so ring i sits at i·ringSpacing meters. Color is
// assigned per tubular quad, not per triangle: both triangles of a quad share the
// same near ring, so keying off that ring puts every band boundary exactly on a
// ring (a flat, clean cut). Keying off a triangle centroid instead would split a
// quad diagonally where a boundary falls between its two triangles' centroids,
// producing sawtooth teeth around the tube. Band size is in meters, so a chunk is
// the same length everywhere. Returns one non-indexed geometry per color present.
function bandTube(
  geo: THREE.BufferGeometry,
  length: number,
  tubular: number,
  colors: string[],
): Array<[string, THREE.BufferGeometry]> {
  const { candy, radialSegments } = NETWORK_STYLE.tube;
  const ringSpacing = length / tubular; // meters advanced per ring step
  const ring = radialSegments + 1;

  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const index = geo.getIndex();
  if (!index) return [];

  const ringOf = (idx: number): number => Math.floor(idx / ring);
  const triColor = (a: number, b: number, c: number): string => {
    // Both triangles of a quad span [near, near+1]; band by the quad midpoint so
    // the boundary lands on a ring rather than slicing through the quad.
    const near = Math.min(ringOf(a), ringOf(b), ringOf(c));
    const sMeters = (near + 0.5) * ringSpacing;
    const n = colors.length;
    return colors[((Math.floor(sMeters / candy.bandLengthM) % n) + n) % n];
  };

  const buckets = new Map<string, { p: number[]; n: number[] }>();
  const arr = index.array;
  for (let t = 0; t < arr.length; t += 3) {
    const tri = [arr[t], arr[t + 1], arr[t + 2]];
    const color = triColor(tri[0], tri[1], tri[2]);
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
