import type { DebugGraph, DebugPolyline } from "@nyc-subwhere/contract";
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
import {
  type GlowEffect,
  TrainOutlinePass,
  cameraDirLocal,
  createGlow,
} from "./train-glow";
import type { TrainPose } from "./trains";

// three.js render layer the train boxes also live on, so the bloom effect can
// render just the trains by restricting the camera to it (doc02.03).
const TRAIN_LAYER = 1;

// Debug centerline pipes (doc02.07): skinny tubes drawn in place of the tracks to inspect a
// pipeline stage's raw geometry. Radius far under the 26 m half-ribbon so they read as thin.
const DEBUG_PIPE_RADIUS = 3;

// Pucks and trains sit physically above the track floors, but the floors grade-separate with
// polygonOffset (track-render.ts) whose slope-dependent factor biases them far forward in the depth
// buffer at grazing / zoomed-out angles — enough to beat an unoffset puck, so stations sink under
// the tracks. Give pucks (and trains, above them) a stronger negative offset than the deepest floor
// level (MAX_LEVEL 4 → factor -4, units -16) so they always win the depth test. Depth-only; no
// geometry is moved.
const PUCK_DEPTH_OFFSET: [number, number] = [-6, -24]; // [factor, units]
const TRAIN_DEPTH_OFFSET: [number, number] = [-8, -32];

type LngLat = [number, number];
// One baked borough polygon (doc01.03 Basemap): rings[0] is the outer boundary,
// any further rings are holes.
export type BoroughPolygon = LngLat[][];

// Per-station placement in the meter-scaled local frame: offset from `origin`
// (X east, Z south). Pucks are radially symmetric, so no bearing is needed.
type Placement = { x: number; z: number };

// A geometric hit, resolved to the index/id the caller keyed its metadata by
// (doc01.03). This layer stays free of Trip/Station semantics: main.ts turns a
// PickResult into an inspector target from its own baked props + live snapshot.
export type PickResult =
  | { kind: "segment"; segmentIndex: number }
  | { kind: "station"; stationIndex: number }
  | { kind: "train"; tripId: string }
  | { kind: "bikeStation"; bikeStationIndex: number };

// A single MapLibre custom layer that renders the whole static network in 3D in
// one shared Three.js scene (doc02.03): route track drawn by a swappable
// TrackRenderer (track-render.ts), stations as an instanced "puck" disc that
// stays visible at every zoom.
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
  private pucks?: THREE.InstancedMesh;
  private waterTexture?: THREE.Texture;
  private trains?: THREE.InstancedMesh;
  private readonly glow: GlowEffect = createGlow();
  private readonly outline = new TrainOutlinePass();
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
  private lightingEnabled = true;
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
  private readonly debug: DebugGraph;
  // One merged pipe mesh per debug layer, hidden until selected; -1 = none active (tracks shown).
  private readonly debugMeshes: { label: string; mesh: THREE.Mesh }[] = [];
  private activeDebug = -1;
  // View mode (doc01.04): Bike View's thin network and small pucks are built
  // lazily on first entry and visibility-flipped against the subway build.
  private viewMode: "subway" | "bike" = "subway";
  private thinNetwork?: THREE.Mesh;
  private smallPucks?: THREE.InstancedMesh;
  private bikeStations?: THREE.InstancedMesh;
  // The current train core's height — discs and boxes differ, and seating needs it.
  private trainHeight = NETWORK_STYLE.train.height;

  constructor(
    stations: LngLat[],
    segments: TrackSegment[],
    graph: TrackGraph,
    boroughs: BoroughPolygon[] = [],
    debug: DebugGraph = { layers: [] },
  ) {
    this.segments = segments;
    this.graph = graph;
    this.boroughs = boroughs;
    this.debug = debug;
    this.placements = stations.map((s) => this.toLocal(s));
  }

  private toLocal(lngLat: LngLat): { x: number; z: number } {
    const m = maplibregl.MercatorCoordinate.fromLngLat(lngLat, 0);
    return {
      x: (m.x - this.origin.x) / this.meterScale,
      z: (m.y - this.origin.y) / this.meterScale,
    };
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
    this.pucks = this.buildPucks(NETWORK_STYLE.puck);
    this.pucks.userData.kind = "station";
    this.scene.add(this.pucks);
    this.buildDebugLayers();

    // No antialias here: this renderer adopts MapLibre's existing GL context, and
    // MSAA is a context-creation attribute — it's requested on the Map constructor
    // (main.ts) instead. Passing it to an already-created context does nothing.
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
    });
    this.renderer.autoClear = false;
    this.glow.onAdd(this.renderer, this.scene);

    map.on("zoom", this.syncZoom);
    this.syncZoom();
  }

  onRemove() {
    this.map.off("zoom", this.syncZoom);
    this.glow.dispose();
    this.outline.dispose();
    this.waterTexture?.dispose();
    this.renderer.dispose();
  }

  // Raycast the scene at a screen point (doc01.03). The camera's projectionMatrix
  // already folds in the local->clip transform render() composes each frame, so
  // its inverse maps a clip-space near/far pair straight into the mesh's meter
  // frame — no view matrix to undo. Nearest hit wins; invisible meshes (e.g. the
  // trains when toggled off) are skipped by three.
  pick(point: { x: number; y: number }): PickResult | null {
    const canvas = this.map.getCanvas();
    const ndcX = (point.x / canvas.clientWidth) * 2 - 1;
    const ndcY = -(point.y / canvas.clientHeight) * 2 + 1;
    const inv = this.camera.projectionMatrix.clone().invert();
    const near = new THREE.Vector3(ndcX, ndcY, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(ndcX, ndcY, 1).applyMatrix4(inv);
    this.raycaster.set(near, far.sub(near).normalize());

    // The subway network is inert in Bike View (doc01.04 BV-2): its meshes leave
    // the target list entirely, so only the Citi Bike docks are pickable there.
    const targets: THREE.Object3D[] = [];
    if (this.viewMode === "bike") {
      if (this.bikeStations) targets.push(this.bikeStations);
    } else {
      targets.push(...(this.trackBuild?.objects ?? []));
      if (this.pucks) targets.push(this.pucks);
      if (this.trains) targets.push(this.trains);
    }

    for (const hit of this.raycaster.intersectObjects(targets, false)) {
      const kind = hit.object.userData.kind;
      if (kind === "bikeStation" && hit.instanceId != null) {
        return { kind: "bikeStation", bikeStationIndex: hit.instanceId };
      }
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
    // Cel outline last, over whatever the glow composited. Its mask render is
    // always trains-only (unlike the bloom source, which may be the whole scene).
    this.outline.render(this.renderer, () => {
      this.camera.layers.set(TRAIN_LAYER);
      this.renderer.render(this.scene, this.camera);
      this.camera.layers.set(0);
    });
    // No unconditional triggerRepaint here — that would repaint the full scene +
    // bloom at max FPS forever, even on a static view. The animation loop is driven
    // by setTrains (called every rAF frame from main.ts), which re-arms a repaint
    // only while trains are actually moving. Camera interaction repaints on its own.
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

  private buildPucks(size: {
    radius: number;
    height: number;
  }): THREE.InstancedMesh {
    const geo = new THREE.CylinderGeometry(
      size.radius,
      size.radius,
      size.height,
      24,
    );
    const mat = this.lighting.stationMaterial();
    mat.polygonOffset = true;
    [mat.polygonOffsetFactor, mat.polygonOffsetUnits] = PUCK_DEPTH_OFFSET;
    const mesh = new THREE.InstancedMesh(geo, mat, this.placements.length);
    // Seat the puck so its top clears the top of the track (its wall tops).
    const centerY =
      trackTopY() + NETWORK_STYLE.puck.clearanceOverTube - size.height / 2;
    const m = new THREE.Matrix4();
    this.placements.forEach((p, i) => {
      m.makeTranslation(p.x, centerY, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  // Replace the live-train instances with the current frame's poses (doc02.04).
  // Called every animation frame by the interpolation loop in main.ts; the mesh
  // is grown lazily as the fleet size climbs. Each train is one elongated box,
  // rotated flat about the vertical axis so its length runs along its travel
  // bearing (X=east, Z=south local frame).
  setTrains(poses: TrainPose[]) {
    if (!this.trains || poses.length > this.trainCapacity) {
      this.rebuildTrains(Math.max(64, poses.length));
    }
    this.currentPoses = poses;
    const core = this.trains;
    if (!core) return;

    const centerY = trainCenterY(this.trainHeight);
    // Discs ride the centerline: the parallel-track visual collapses at Bike
    // View's thin width, so the left-of-travel offset would read as error.
    const off = this.viewMode === "bike" ? 0 : NETWORK_STYLE.track.trainOffsetM;
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

    // Drive the render loop from here rather than an unconditional repaint in
    // render(): request the next frame only while trains are visible and present,
    // so an idle view (trains hidden or none live) stops repainting the scene.
    if (this.trainsVisible && poses.length > 0) this.map.triggerRepaint();
  }

  // Hide/show live trains without dropping the poll+interpolate loop (doc01.03).
  // Not persisted: a reload starts with trains shown. Only the train mesh and its
  // own glow are affected — the scene bloom that lights land/track/stations stays on.
  toggleTrains(): void {
    this.trainsVisible = !this.trainsVisible;
    if (this.trains) this.trains.visible = this.trainsVisible;
    this.glow.setTrainGlowVisible(this.trainsVisible);
    // The render loop idles when trains are hidden, so kick one repaint to draw the
    // change (turning trains back on re-arms the loop via setTrains).
    this.map.triggerRepaint();
  }

  // Swap the Board between Subway View and Bike View (doc01.04): one scene, two
  // representation sets flipped by visibility, so switching re-fetches nothing
  // (VW-2). Trains rebuild so their geometry matches the view. Not persisted: a
  // reload starts in Subway View (VW-1).
  setViewMode(mode: "subway" | "bike"): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    const bike = mode === "bike";
    if (bike && !this.thinNetwork) {
      const mesh = this.buildThinNetwork();
      if (mesh) {
        this.thinNetwork = mesh;
        this.scene.add(mesh);
      }
    }
    if (bike && !this.smallPucks) {
      // No userData.kind: small pucks are never pick targets (BV-2).
      this.smallPucks = this.buildPucks(NETWORK_STYLE.bikeView.station);
      this.scene.add(this.smallPucks);
    }
    for (const obj of this.trackBuild?.objects ?? []) obj.visible = !bike;
    if (this.thinNetwork) this.thinNetwork.visible = bike;
    if (this.pucks) this.pucks.visible = !bike;
    if (this.smallPucks) this.smallPucks.visible = bike;
    if (this.bikeStations) this.bikeStations.visible = bike;
    if (this.trains) {
      this.rebuildTrains(this.trainCapacity);
      this.setTrains(this.currentPoses);
    }
    this.map.triggerRepaint();
  }

  // Bike View's network (doc01.04 VW-3): the junction-synthesized corridor
  // centerlines the bake already publishes ("Centerlines (junctioned)",
  // build-geometry.ts) — one line per corridor, with the authored merge/split
  // geometry connecting lines at junctions. Falls back to the raw per-direction
  // segments if the bake published no debug layers.
  private buildThinNetwork(): THREE.Mesh | null {
    const junctioned = this.debug.layers.find(
      (l) => l.id === "centerlines-junctioned",
    );
    const lines: DebugPolyline[] =
      junctioned?.lines ??
      this.segments.map((s) => ({
        coordinates: s.points,
        color: s.colors[0] ?? "#888888",
      }));
    return this.buildPipes(lines, NETWORK_STYLE.bikeView.lineRadius);
  }

  // Merge colored polylines into one self-lit skinny-tube mesh, seated at the
  // track top so it reads at the same height as the platforms it replaces.
  // Shared by the debug pipe layers and Bike View's thin network. Degenerate
  // points are dropped so the tube stays finite; null when nothing survives.
  private buildPipes(
    lines: DebugPolyline[],
    radius: number,
  ): THREE.Mesh | null {
    const y = trackTopY();
    const geos: THREE.BufferGeometry[] = [];
    for (const line of lines) {
      const pts: THREE.Vector3[] = [];
      for (const ll of line.coordinates) {
        const { x, z } = this.toLocal(ll);
        const prev = pts[pts.length - 1];
        if (prev && prev.x === x && prev.z === z) continue;
        pts.push(new THREE.Vector3(x, y, z));
      }
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(
        curve,
        Math.max(2, (pts.length - 1) * 3),
        radius,
        6,
        false,
      );
      const c = new THREE.Color(line.color);
      const n = tube.getAttribute("position").count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
      tube.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geos.push(tube);
    }
    if (geos.length === 0) return null;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    );
    mesh.frustumCulled = false;
    return mesh;
  }

  // Citi Bike docks as one instanced white disc mesh, replacing any previous set
  // (the dock index refreshes hourly). Seated like the station pucks so the discs
  // read at the same height; visible only in Bike View, where they are the sole
  // pick targets (see pick()).
  setBikeStations(points: LngLat[]): void {
    if (this.bikeStations) {
      this.scene.remove(this.bikeStations);
      this.bikeStations.geometry.dispose();
    }
    const style = NETWORK_STYLE.bikeView.bikeStation;
    const geo = new THREE.CylinderGeometry(
      style.radius,
      style.radius,
      style.height,
      24,
    );
    const mat = new THREE.MeshBasicMaterial({ color: style.color });
    mat.polygonOffset = true;
    [mat.polygonOffsetFactor, mat.polygonOffsetUnits] = PUCK_DEPTH_OFFSET;
    const mesh = new THREE.InstancedMesh(geo, mat, points.length);
    const centerY =
      trackTopY() + NETWORK_STYLE.puck.clearanceOverTube - style.height / 2;
    const m = new THREE.Matrix4();
    points.forEach((p, i) => {
      const { x, z } = this.toLocal(p);
      m.makeTranslation(x, centerY, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.userData.kind = "bikeStation";
    mesh.visible = this.viewMode === "bike";
    this.bikeStations = mesh;
    this.scene.add(mesh);
    this.map.triggerRepaint();
  }

  // Enable/disable the scene bloom — the glow that lights the whole network. Off
  // leaves the flat base render (land, track, stations, trains) with no bloom.
  // Not persisted: a reload starts with lighting on.
  toggleLighting(): void {
    this.lightingEnabled = !this.lightingEnabled;
    this.glow.setEnabled(this.lightingEnabled);
    this.map.triggerRepaint();
  }

  // Build one merged skinny-pipe mesh per debug layer (doc02.07), hidden until
  // cycleDebug selects it.
  private buildDebugLayers(): void {
    for (const layer of this.debug.layers) {
      const mesh = this.buildPipes(layer.lines, DEBUG_PIPE_RADIUS);
      if (!mesh) continue;
      mesh.visible = false;
      this.scene.add(mesh);
      this.debugMeshes.push({ label: layer.label, mesh });
    }
  }

  // Advance the exclusive debug view: none → layer 0 → … → last → none. While a layer is active the
  // baked tracks (fill + walls + carets) and live trains are hidden so only the centerline pipes
  // show. Returns the active layer's label, or "off". Not persisted; a reload starts on the tracks.
  cycleDebug(): string {
    this.activeDebug =
      this.activeDebug + 1 >= this.debugMeshes.length
        ? -1
        : this.activeDebug + 1;
    const active = this.activeDebug >= 0;
    this.debugMeshes.forEach((d, i) => {
      d.mesh.visible = i === this.activeDebug;
    });
    // Leaving the debug cycle restores whichever view is current, not always the
    // subway ribbons.
    const subway = this.viewMode === "subway";
    for (const obj of this.trackBuild?.objects ?? [])
      obj.visible = !active && subway;
    if (this.thinNetwork) this.thinNetwork.visible = !active && !subway;
    if (this.bikeStations) this.bikeStations.visible = !active && !subway;
    if (this.trains) this.trains.visible = active ? false : this.trainsVisible;
    this.map.triggerRepaint();
    return active ? this.debugMeshes[this.activeDebug].label : "off";
  }

  private rebuildTrains(capacity: number) {
    if (this.trains) {
      this.scene.remove(this.trains);
      this.trains.geometry.dispose();
    }
    const { train, bikeView } = NETWORK_STYLE;

    // Core: a solid, fully self-lit shape (unlit MeshBasic) so the train reads at
    // full Route color against the dimmer, shaded tubes below it. Subway View is
    // an elongated box — local +X = length (along travel), Y = height, Z = width
    // (across); Bike View is a small disc (doc01.04 BV-1), radially symmetric so
    // the pose loop's bearing rotation is harmless. setColorAt tints each
    // instance, so one material carries every Route color.
    const bike = this.viewMode === "bike";
    const coreGeo = bike
      ? new THREE.CylinderGeometry(
          bikeView.train.radius,
          bikeView.train.radius,
          bikeView.train.height,
          20,
        )
      : new THREE.BoxGeometry(train.length, train.height, train.width);
    this.trainHeight = bike ? bikeView.train.height : train.height;
    const trainMat = new THREE.MeshBasicMaterial();
    trainMat.polygonOffset = true;
    [trainMat.polygonOffsetFactor, trainMat.polygonOffsetUnits] =
      TRAIN_DEPTH_OFFSET;
    const core = new THREE.InstancedMesh(coreGeo, trainMat, capacity);
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
function trainCenterY(coreHeight: number): number {
  const { puck, train } = NETWORK_STYLE;
  const puckTop = trackTopY() + puck.clearanceOverTube;
  return puckTop + train.clearance + coreHeight / 2;
}
