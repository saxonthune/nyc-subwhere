import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LightingSystem } from "./lighting";
import { NETWORK_STYLE } from "./network-style";
import {
  FlatTrackRenderer,
  type TrackBuild,
  type TrackGraph,
  type TrackRenderer,
  type TrackSegment,
  trackTopY,
} from "./track-render";
import { type GlowEffect, cameraDirLocal, createGlow } from "./train-glow";
import type { TrainPose } from "./trains";

// three.js render layer the train boxes also live on, so the bloom effect can
// render just the trains by restricting the camera to it (doc02.03).
const TRAIN_LAYER = 1;

type LngLat = [number, number];
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

// A single MapLibre custom layer that renders the whole static network in 3D in
// one shared Three.js scene (doc02.03): route track drawn by a swappable
// TrackRenderer (track-render.ts), stations as an instanced "puck" disc above an
// instanced grey platform box oriented along the track. The puck fades out as the
// map zooms in, so close in the track reads over the platform boxes with no puck
// occluding them.
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
  private readonly lighting = new LightingSystem();
  private trainCapacity = 0;
  // Packed per-frame train draw data handed to the glow effect (train-glow.ts),
  // grown with the core mesh so no per-frame allocation is needed.
  private glowPositions = new Float32Array(0);
  private glowBearings = new Float32Array(0);
  private glowColors = new Float32Array(0);
  private readonly trackRenderer: TrackRenderer = new FlatTrackRenderer();
  private trackBuild?: TrackBuild;
  private currentPoses: TrainPose[] = [];
  private trainsVisible = true;
  private readonly raycaster = new THREE.Raycaster();

  private readonly origin = maplibregl.MercatorCoordinate.fromLngLat(
    [-73.98, 40.75],
    0,
  );
  private readonly meterScale = this.origin.meterInMercatorCoordinateUnits();
  private readonly placements: Placement[];
  private readonly segments: TrackSegment[];
  private readonly graph: TrackGraph;
  private readonly boroughs: BoroughPolygon[];

  constructor(
    stations: LngLat[],
    segments: TrackSegment[],
    graph: TrackGraph,
    boroughs: BoroughPolygon[] = [],
  ) {
    this.segments = segments;
    this.graph = graph;
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

    this.lighting.addLights(this.scene);

    // Basemap first (doc01.03): water plane at the bottom, grey borough land above
    // it, both beneath the network. They carry no userData.kind, so pick() never
    // sees them and clicks pass through to the tracks and stations.
    this.scene.add(this.buildWater());
    const land = this.buildLand();
    if (land) this.scene.add(land);

    this.trackBuild = this.trackRenderer.build(this.segments, this.graph, {
      toLocal: (p) => this.toLocal(p),
    });
    for (const obj of this.trackBuild.objects) this.scene.add(obj);
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

    const targets: THREE.Object3D[] = [...(this.trackBuild?.objects ?? [])];
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
      } else if (kind === "segment") {
        const seg = this.trackBuild?.segmentOfHit(hit);
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
        // Bloom source. "scene": render everything, so the luminance threshold in the
        // bloom pass tiers the glow by role (trains brightest, then track/stations,
        // then the dim land; the dark water falls away). "trains": restrict the camera
        // to the train layer so only the train boxes feed the bloom (the older
        // trains-only glow, regardless of Route-color luminance).
        if (NETWORK_STYLE.lighting.bloom.source === "trains") {
          this.camera.layers.set(TRAIN_LAYER);
          this.renderer.render(this.scene, this.camera);
          this.camera.layers.set(0);
        } else {
          this.renderer.render(this.scene, this.camera);
        }
      },
    );
    this.map.triggerRepaint();
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
    // The borough outer rings in the local frame feed the shoreline distance field
    // the water shades against, so its blue is keyed to the real coast.
    const landRings = this.boroughs
      .map((b) => b[0])
      .filter((r) => r && r.length >= 3)
      .map((r) => r.map((p) => this.toLocal(p)));
    const { material, texture } = this.lighting.waterMaterial(landRings);
    this.waterTexture = texture;
    const mesh = new THREE.Mesh(geo, material);
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
    // DoubleSide (in landMaterial) so the top face reads lit regardless of winding.
    const mesh = new THREE.Mesh(merged, this.lighting.landMaterial());
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
    this.puckMaterial = this.lighting.stationMaterial();
    const mesh = new THREE.InstancedMesh(
      geo,
      this.puckMaterial,
      this.placements.length,
    );
    // Seat the puck so its top clears the top of the track (its wall tops).
    const centerY = trackTopY() + puck.clearanceOverTube - puck.height / 2;
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
    const off = NETWORK_STYLE.track.trainOffsetM;
    const rot = new THREE.Matrix4();
    const pos = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    // Blink factor for uncertain trains (doc01.03): a ~1.6s luminance pulse
    // applied to box + glow, so a train the Board can no longer place reads as
    // attention-seeking rather than confidently wrong.
    const blink = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(performance.now() / 260));
    poses.forEach((p, i) => {
      const c = this.toLocal(p.lngLat);
      // Shift onto the same side as the track ribbon (offsetLeft in the flipped
      // local frame): perpendicular (sin, cos) of the travel bearing, so the train
      // rides its own track instead of floating on the centerline.
      const x = c.x + Math.sin(p.bearing) * off;
      const z = c.z + Math.cos(p.bearing) * off;
      rot.makeRotationY(p.bearing);
      pos.makeTranslation(x, centerY, z);
      m.multiplyMatrices(pos, rot);
      core.setMatrixAt(i, m);
      color.set(p.color);
      if (p.uncertain) color.multiplyScalar(blink);
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
    this.trackBuild?.setZoom(zoom, this.metersPerPixel(zoom));
    if (this.boxes) this.boxes.visible = zoom >= NETWORK_STYLE.box.minZoom;

    const { fadeStartZoom, fadeEndZoom } = NETWORK_STYLE.puck;
    const t = (zoom - fadeStartZoom) / (fadeEndZoom - fadeStartZoom);
    const opacity = 1 - Math.min(1, Math.max(0, t));
    if (this.puckMaterial) this.puckMaterial.opacity = opacity;
    if (this.pucks) this.pucks.visible = opacity > 0;
  };

  // Ground meters per screen pixel at the map center for a zoom (Web Mercator, 512px
  // tiles): earth circumference · cos(lat) / (512 · 2^zoom). Feeds the track LOD so
  // its pattern can be sized in screen space rather than fixed meters.
  private metersPerPixel(zoom: number): number {
    const lat = this.map.getCenter().lat;
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  }
}

// Train underside rests `train.clearance` above the puck top, which itself sits
// `puck.clearanceOverTube` above the top of the track — so trains read as sitting
// on top of both the track and the pucks.
function trainCenterY(): number {
  const { puck, train } = NETWORK_STYLE;
  const puckTop = trackTopY() + puck.clearanceOverTube;
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
