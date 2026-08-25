import type {
  DebugGraph,
  DebugPolyline,
  StreetGrid,
} from "@nyc-subwhere/contract";
import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BikeDiscGauges } from "./bike-disc-gauge";
import { type BikeResourceCounts, BikeScoreboards } from "./bike-scoreboard";
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
import { UserMarker } from "./user-marker";

// three.js render layer the train boxes (and Bike View's docks) also live on,
// so the bloom effect and the cel outline pass can render just them by
// restricting the camera to it (doc02.03).
const TRAIN_LAYER = 1;

// three.js render layer for the Bike View gauge sectors, excluded from the
// base scene render and drawn in a dedicated pass after the bloom composites,
// so the dock discs' white glow never washes over the sector colors.
const GAUGE_LAYER = 2;

// three.js render layer for the backdrop (water, land, street ribbons). Drawn
// in the base scene render but skipped in the bloom-source re-render: these
// surfaces sit below the bloom's luminance threshold, so re-rendering them
// there paid the full vertex and fill cost of the citywide geometry twice per
// frame for no visible glow.
const BACKDROP_LAYER = 3;

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
// Gauge faces float just above the dock discs and must also beat them in the
// depth buffer at grazing angles, so one step past the puck offset.
const GAUGE_DEPTH_OFFSET: [number, number] = [-7, -28];

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
  private readonly streets: StreetGrid;
  // One merged pipe mesh per debug layer, hidden until selected; -1 = none active (tracks shown).
  private readonly debugMeshes: { label: string; mesh: THREE.Mesh }[] = [];
  private activeDebug = -1;
  // View mode (doc01.04): Bike View's thin network and small pucks are built
  // lazily on first entry and visibility-flipped against the subway build.
  private viewMode: "subway" | "bike" = "subway";
  private thinNetwork?: THREE.Mesh;
  private smallPucks?: THREE.InstancedMesh;
  private bikeStations?: THREE.InstancedMesh;
  private bikePlacements: Placement[] = [];
  private bikeScoreboards?: BikeScoreboards;
  private bikeGauges?: BikeDiscGauges;
  private userMarker?: UserMarker;
  // One merged ribbon mesh per street tier (built lazily with the rest of Bike
  // View); visibility is mode × zoom × debug, resolved in syncStreetVisibility.
  private streetTiers: THREE.Mesh[] = [];
  // The current train core's height — discs and boxes differ, and seating needs it.
  private trainHeight = NETWORK_STYLE.train.height;

  constructor(
    stations: LngLat[],
    segments: TrackSegment[],
    graph: TrackGraph,
    boroughs: BoroughPolygon[] = [],
    debug: DebugGraph = { layers: [] },
    streets: StreetGrid = { tiers: [] },
  ) {
    this.segments = segments;
    this.graph = graph;
    this.boroughs = boroughs;
    this.debug = debug;
    this.streets = streets;
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

    // The base render must include the backdrop layer alongside the default;
    // restricted passes reset through restoreCameraLayers() to keep it on.
    this.camera.layers.enable(BACKDROP_LAYER);

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

  private readonly rendererSize = new THREE.Vector2();

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrix: Parameters<maplibregl.CustomRenderMethod>[1],
  ) {
    // Three adopts MapLibre's canvas but caches its own width/height from
    // construction time, and every setRenderTarget(null) re-applies a viewport
    // from that cache — so after a canvas resize (devtools opening, window
    // resize) the fullscreen post-process passes (bloom composite, outline)
    // land offset from the base scene. Sync the cache to the real drawing
    // buffer before drawing. Pixel ratio stays 1: sizes here are buffer pixels.
    const dbw = gl.drawingBufferWidth;
    const dbh = gl.drawingBufferHeight;
    this.renderer.getSize(this.rendererSize);
    if (this.rendererSize.x !== dbw || this.rendererSize.y !== dbh) {
      this.renderer.setSize(dbw, dbh, false);
    }

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

    // Keep the dock scoreboards facing the camera; bearing only changes during
    // camera interaction, which is already repainting.
    this.bikeScoreboards?.setBearing(this.map.getBearing());

    // Counterscale the user marker so it never drops under screenPx pixels
    // across, clamped at 1 so up close it keeps its natural meter size. Free:
    // this runs inside renders the map was doing anyway, and a still camera
    // means a still scale.
    if (this.userMarker) {
      const um = NETWORK_STYLE.userMarker;
      const mpp = this.metersPerPixel(this.map.getZoom());
      this.userMarker.setScale(
        Math.max(1, (um.screenPx * mpp) / (2 * um.radius)),
      );
    }

    this.renderer.resetState();
    this.glow.render(
      () => this.renderer.render(this.scene, this.camera),
      () => {
        // Bloom source. "scene": render everything but the backdrop layer, so the
        // luminance threshold in the bloom pass tiers the glow by role (trains
        // brightest, then track/stations); water, land, and streets sit below the
        // threshold, so skipping their citywide geometry here changes nothing
        // visibly and halves the backdrop's per-frame cost. "trains": restrict
        // the camera to the train layer so only the train boxes feed the bloom
        // (the older trains-only glow, regardless of Route-color luminance).
        if (NETWORK_STYLE.lighting.bloom.source === "trains") {
          this.camera.layers.set(TRAIN_LAYER);
        } else {
          this.camera.layers.disable(BACKDROP_LAYER);
        }
        this.renderer.render(this.scene, this.camera);
        this.restoreCameraLayers();
      },
    );
    // Gauge sectors over the composited bloom: their layer is excluded from
    // the base render, and the canvas depth buffer still holds the scene (the
    // glow strategies render the base straight to screen and only add an
    // overlay), so this pass depth-tests correctly against discs and trains.
    if (this.bikeGauges) {
      this.camera.layers.set(GAUGE_LAYER);
      this.renderer.render(this.scene, this.camera);
      this.restoreCameraLayers();
    }
    // Cel outline last, over whatever the glow composited. Its mask render is
    // always the train layer — trains, plus Bike View's docks (unlike the
    // bloom source, which may be the whole scene).
    this.outline.render(this.renderer, () => {
      this.camera.layers.set(TRAIN_LAYER);
      this.renderer.render(this.scene, this.camera);
      this.restoreCameraLayers();
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
    mesh.layers.set(BACKDROP_LAYER);
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
    mesh.layers.set(BACKDROP_LAYER);
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

  // Bike View's receded subway stations: small squares seated like the pucks,
  // but drawn as a dimmed unlit solid instead of the emissive station glow —
  // part of turning the whole subway side down under the docks (networkDim).
  private buildSquareStations(size: {
    side: number;
    height: number;
    dim: number;
  }): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(size.side, size.height, size.side);
    const color = new THREE.Color(
      NETWORK_STYLE.lighting.station.color,
    ).multiplyScalar(NETWORK_STYLE.bikeView.networkDim * size.dim);
    const mat = new THREE.MeshBasicMaterial({ color });
    mat.polygonOffset = true;
    [mat.polygonOffsetFactor, mat.polygonOffsetUnits] = PUCK_DEPTH_OFFSET;
    const mesh = new THREE.InstancedMesh(geo, mat, this.placements.length);
    const centerY =
      trackTopY() + NETWORK_STYLE.puck.clearanceOverTube - size.height / 2;
    // Corners point along the Manhattan grid: an unrotated square's NE corner
    // sits at bearing 45°, and a positive Y rotation turns bearings down, so
    // 45° − gridBearingDeg lands the diagonal on the avenue bearing.
    const rot = new THREE.Matrix4().makeRotationY(
      ((45 - NETWORK_STYLE.bikeView.gridBearingDeg) * Math.PI) / 180,
    );
    const pos = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    this.placements.forEach((p, i) => {
      pos.makeTranslation(p.x, centerY, p.z);
      m.multiplyMatrices(pos, rot);
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
    // Bike View turns the whole subway side down: train (and glow) colors are
    // scaled like the thin network and station squares (networkDim).
    const dim =
      this.viewMode === "bike" ? NETWORK_STYLE.bikeView.networkDim : 1;
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
      color.set(p.color).multiplyScalar(dim);
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
      this.smallPucks = this.buildSquareStations(
        NETWORK_STYLE.bikeView.station,
      );
      this.scene.add(this.smallPucks);
    }
    if (bike && this.streetTiers.length === 0) this.buildStreetTiers();
    for (const obj of this.trackBuild?.objects ?? []) obj.visible = !bike;
    if (this.thinNetwork) this.thinNetwork.visible = bike;
    if (this.pucks) this.pucks.visible = !bike;
    if (this.smallPucks) this.smallPucks.visible = bike;
    this.syncBikeMarkers();
    this.syncStreetVisibility();
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
    return this.buildPipes(
      lines,
      NETWORK_STYLE.bikeView.lineRadius,
      NETWORK_STYLE.bikeView.networkDim,
    );
  }

  // The street grid (doc01.04): the baked OSM streets as one merged flat ribbon
  // mesh per tier, etched onto the land plate in a grey darker than the land.
  // Ribbons rather than GL lines (which clamp to 1px hairlines) or tubes (absurd
  // at ~65k polylines): each polyline becomes a widthM-wide strip of two
  // triangles per segment, joined at vertices by the averaged perpendicular.
  // Never pick targets. Tier visibility is the semantic LOD, resolved in
  // syncStreetVisibility.
  private buildStreetTiers(): void {
    const { streets } = NETWORK_STYLE.bikeView;
    const y = streets.lift;
    this.streets.tiers.forEach((lines, tierIndex) => {
      const style = streets.tiers[tierIndex];
      if (!style) return;
      const geo = this.buildRibbonGeometry(lines, style.widthM / 2, y);
      if (!geo) return;
      const mat = new THREE.MeshBasicMaterial({
        color: style.color,
        side: THREE.DoubleSide,
      });
      // Nudge the ribbons forward in the depth buffer so the plate they sit just
      // above can't swallow them at grazing zoomed-out angles (same failure the
      // pucks guard against, gentler dose — streets only fight the flat land).
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -8;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.layers.set(BACKDROP_LAYER);
      this.streetTiers[tierIndex] = mesh;
      this.scene.add(mesh);
    });
  }

  // Merge many polylines into one flat ribbon geometry on the y plane: per point,
  // two vertices offset ±halfW along the perpendicular of the averaged adjacent
  // segment directions (no miter-length compensation — sharp bends pinch a
  // little, invisible at backdrop scale).
  private buildRibbonGeometry(
    lines: LngLat[][],
    halfW: number,
    y: number,
  ): THREE.BufferGeometry | null {
    const pts: { x: number; z: number }[][] = [];
    let pointCount = 0;
    for (const line of lines) {
      const p: { x: number; z: number }[] = [];
      for (const ll of line) {
        const l = this.toLocal(ll);
        const prev = p[p.length - 1];
        if (prev && prev.x === l.x && prev.z === l.z) continue;
        p.push(l);
      }
      if (p.length < 2) continue;
      pts.push(p);
      pointCount += p.length;
    }
    if (pointCount === 0) return null;

    const positions = new Float32Array(pointCount * 2 * 3);
    const indices = new Uint32Array((pointCount - pts.length) * 6);
    let v = 0;
    let ix = 0;
    for (const p of pts) {
      const base = v / 3 / 2;
      for (let i = 0; i < p.length; i++) {
        // Averaged direction of the segments meeting at i (one-sided at ends).
        const a = p[Math.max(0, i - 1)];
        const b = p[Math.min(p.length - 1, i + 1)];
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        const nx = -dz * halfW;
        const nz = dx * halfW;
        positions[v++] = p[i].x + nx;
        positions[v++] = y;
        positions[v++] = p[i].z + nz;
        positions[v++] = p[i].x - nx;
        positions[v++] = y;
        positions[v++] = p[i].z - nz;
      }
      for (let i = 0; i < p.length - 1; i++) {
        const q = (base + i) * 2;
        indices[ix++] = q;
        indices[ix++] = q + 1;
        indices[ix++] = q + 2;
        indices[ix++] = q + 1;
        indices[ix++] = q + 3;
        indices[ix++] = q + 2;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
  }

  // Semantic LOD for the street grid: a tier shows only in Bike View, outside
  // the debug cycle, and at/above its minZoom — far out the local grid drops
  // away and only the arterial skeleton stays etched.
  private syncStreetVisibility(): void {
    if (this.streetTiers.length === 0) return;
    const on = this.viewMode === "bike" && this.activeDebug < 0;
    const zoom = this.map.getZoom();
    const { tiers } = NETWORK_STYLE.bikeView.streets;
    this.streetTiers.forEach((mesh, i) => {
      mesh.visible = on && zoom >= (tiers[i]?.minZoom ?? 0);
    });
  }

  // Merge colored polylines into one self-lit skinny-tube mesh, seated at the
  // track top so it reads at the same height as the platforms it replaces.
  // Shared by the debug pipe layers and Bike View's thin network (which passes
  // `dim` to scale its colors down — networkDim). Degenerate points are
  // dropped so the tube stays finite; null when nothing survives.
  private buildPipes(
    lines: DebugPolyline[],
    radius: number,
    dim = 1,
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
      const c = new THREE.Color(line.color).multiplyScalar(dim);
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
    // A new dock set orphans any count markers built for the old placements;
    // the next setBikeCounts rebuilds them aligned.
    if (this.bikeScoreboards) {
      this.bikeScoreboards.dispose();
      this.bikeScoreboards = undefined;
    }
    if (this.bikeGauges) {
      this.bikeGauges.dispose();
      this.bikeGauges = undefined;
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
    this.bikePlacements = points.map((p) => this.toLocal(p));
    this.bikePlacements.forEach(({ x, z }, i) => {
      m.makeTranslation(x, centerY, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.userData.kind = "bikeStation";
    // On the train layer so the cel outline pass inks the docks too (its mask
    // renders that layer). Also feeds the bloom when lighting.bloom.source is
    // "trains" — with the default "scene" source that changes nothing.
    mesh.layers.enable(TRAIN_LAYER);
    this.bikeStations = mesh;
    this.scene.add(mesh);
    this.syncBikeMarkers();
    this.map.triggerRepaint();
  }

  // Per-dock live counts (aligned with the points given to setBikeStations),
  // rebuilt fresh on every push (30s cadence). The "scoreboard" marker replaces
  // the discs visually with count boards; the "gauge" marker keeps the discs as
  // the white base and floats a painted gauge face over each. In both modes the
  // disc mesh stays in the scene as the pick proxy — Mesh.raycast ignores
  // visibility, and pick() targets it explicitly.
  setBikeCounts(counts: (BikeResourceCounts | null)[]): void {
    const style = NETWORK_STYLE.bikeView.bikeStation;
    if (this.bikeScoreboards) {
      this.bikeScoreboards.dispose();
      this.bikeScoreboards = undefined;
    }
    if (this.bikeGauges) {
      this.bikeGauges.dispose();
      this.bikeGauges = undefined;
    }
    if (style.marker === "disc" || this.bikePlacements.length === 0) {
      this.syncBikeMarkers();
      return;
    }
    if (style.marker === "scoreboard") {
      const sb = style.scoreboard;
      const centerY =
        trackTopY() + NETWORK_STYLE.puck.clearanceOverTube + sb.thickness / 2;
      this.bikeScoreboards = new BikeScoreboards(
        this.bikePlacements,
        counts,
        centerY,
        PUCK_DEPTH_OFFSET,
        TRAIN_LAYER,
      );
      this.bikeScoreboards.setBearing(this.map.getBearing());
      this.scene.add(this.bikeScoreboards.group);
    } else {
      // The disc top sits clearanceOverTube above the track top (see
      // setBikeStations); the sector pieces seat themselves against it.
      const discTopY = trackTopY() + NETWORK_STYLE.puck.clearanceOverTube;
      this.bikeGauges = new BikeDiscGauges(
        this.bikePlacements,
        counts,
        discTopY,
        GAUGE_DEPTH_OFFSET,
        GAUGE_LAYER,
      );
      this.scene.add(this.bikeGauges.group);
      // Depleted docks grey out the base disc itself (instance color), since
      // the gauge pieces only cover the sectors that still have stock.
      if (this.bikeStations) {
        const g = style.gauge;
        const c = new THREE.Color();
        const n = Math.min(counts.length, this.bikePlacements.length);
        for (let i = 0; i < n; i++) {
          const ct = counts[i];
          const depleted = !ct || g.slices.some((s) => ct[s.key] === 0);
          c.setScalar(depleted ? g.discDim : 1);
          this.bikeStations.setColorAt(i, c);
        }
        if (this.bikeStations.instanceColor)
          this.bikeStations.instanceColor.needsUpdate = true;
      }
    }
    this.syncBikeMarkers();
    this.map.triggerRepaint();
  }

  // One place for the dock-marker visibility rule: markers show only in Bike
  // View with no debug layer active. The discs yield to the scoreboards, which
  // replace them; gauge faces ride on the discs, so both stay visible there.
  private syncBikeMarkers(): void {
    const show = this.viewMode === "bike" && this.activeDebug < 0;
    if (this.bikeScoreboards) this.bikeScoreboards.group.visible = show;
    if (this.bikeGauges) this.bikeGauges.group.visible = show;
    if (this.bikeStations)
      this.bikeStations.visible = show && !this.bikeScoreboards;
  }

  // The user's live position (user-location.ts drives this): built lazily on
  // the first fix, moved on later ones, dropped on null. Shown in both views —
  // it is the user, not part of either representation. On the train layer for
  // the cel outline; never a pick target (pick() lists its targets explicitly).
  setUserLocation(
    lngLat: LngLat | null,
    headingDeg: number | null = null,
  ): void {
    if (!lngLat) {
      if (!this.userMarker) return;
      this.userMarker.dispose();
      this.userMarker = undefined;
      this.map.triggerRepaint();
      return;
    }
    if (!this.userMarker) {
      this.userMarker = new UserMarker(TRAIN_DEPTH_OFFSET, TRAIN_LAYER);
      this.scene.add(this.userMarker.group);
    }
    const { x, z } = this.toLocal(lngLat);
    this.userMarker.setPosition(x, z);
    this.userMarker.setHeading(headingDeg);
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
    this.syncBikeMarkers();
    this.syncStreetVisibility();
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
    // (across); Bike View is a small flat square (doc01.04 BV-1), oriented along
    // travel by the pose loop's bearing rotation. setColorAt tints each
    // instance, so one material carries every Route color.
    const bike = this.viewMode === "bike";
    const coreGeo = bike
      ? new THREE.BoxGeometry(
          bikeView.train.side,
          bikeView.train.height,
          bikeView.train.side,
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

  // The base layer set the full-scene renders use: the default layer plus the
  // backdrop. Every restricted pass ends by restoring this rather than a bare
  // layers.set(0), which would silently drop the backdrop from later frames.
  private restoreCameraLayers(): void {
    this.camera.layers.set(0);
    this.camera.layers.enable(BACKDROP_LAYER);
  }

  private syncZoom = () => {
    const zoom = this.map.getZoom();
    this.trackBuild?.setZoom(zoom, this.metersPerPixel(zoom));
    this.syncStreetVisibility();
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
