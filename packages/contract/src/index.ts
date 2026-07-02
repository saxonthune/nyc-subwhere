// --- Live render frame (doc02.04) ---------------------------------------
// The frame the worker ships each poll and the web app renders on top of the
// baked geometry below. See doc01.01 (glossary) for terms, doc02.04 (backend)
// for how the worker produces it, doc01.03 for the behaviors it serves.
//
// Invariant: this expresses resolved position-in-time, never raw feed mechanics
// or how the worker derived anything. Every future worker — naive passthrough,
// snapshot-diffing, schedule-fused — only improves the *quality* of `lastKnownStop`
// and `upcoming`, never their shape. That keeps the web app's interpolation
// frozen as the worker gets cleverer.

/** Epoch milliseconds on the worker's clock. */
export type EpochMs = number;

export interface RenderSnapshot {
  /** Worker clock when this frame was built — the web app uses it for
   *  clock-skew correction and to tell how stale its data has gone. */
  asOf: EpochMs;
  trips: TripState[];
}

export interface TripState {
  tripId: string;
  routeId: string;
  direction: Direction;

  /** Where the Trip was last known to be — the stop *behind* its current
   *  segment. A resolved fact, not a prediction; the sink for all of the
   *  worker's present and future arrival-detection work. */
  lastKnownStop: LastKnownStop;

  /** Forward keyframes the web app interpolates across — the next N stops.
   *  N is the worker's choice (the render "runway"), bounded by the 30-min
   *  Trip Replacement Period (doc02.02): more stops = more resilience to a
   *  late poll before the train must blink. */
  upcoming: StopArrival[];

  /** The worker's verdict on motion, when it has one. Absent until the worker
   *  diffs snapshots to detect a stall (doc02.04); the web app renders
   *  correctly without it, and its own lost-runway blink needs no worker input. */
  status?: TripMotion;
}

export type TripMotion = "progressing" | "stalled";

export interface LastKnownStop {
  stopId: string; // directional stop_id, e.g. "127N"
  /** When the Trip was at this stop (departed / observed). */
  at: EpochMs;
}

export interface StopArrival {
  stopId: string; // directional stop_id, e.g. "125N"
  arrival: EpochMs;
  departure: EpochMs | null;
}

// --- Baked map geometry (doc02.05) --------------------------------------
// Produced at build time by @nyc-subwhere/geometry, consumed at runtime by
// @nyc-subwhere/web. The worker does not read these; it only ships live
// frames the web app renders on top of this geometry.

export type LngLat = [number, number]; // [lon, lat] — GeoJSON/MapLibre order

export type Direction = "N" | "S";

export interface StationProperties {
  stopId: string; // parent station id, e.g. "127"
  name: string;
  platforms: string[]; // directional stop_ids the realtime feed reports, e.g. ["127N", "127S"]
}

export interface SegmentProperties {
  // A segment is one physical inter-station track, conflated across every Route
  // that runs it (doc02.05), so shared trunks draw once instead of stacking.
  routes: string[]; // all routeIds on this track, sorted (for inspection/interaction)
  direction: Direction;
  // Every distinct color among those routes — the truth, uncapped (Flatbush
  // carries 4). The renderer decides how to draw what it can (doc01.03).
  colors: string[];
  // The first three, flattened into scalar props so MapLibre style expressions
  // stay simple `get`s (array `at`/`length` on `get` fail the expression
  // type-checker). colorCount is the true count and may exceed 3.
  colorCount: number;
  color0: string;
  color1: string; // "" when colorCount < 2
  color2: string; // "" when colorCount < 3
}

export interface PointGeometry {
  type: "Point";
  coordinates: LngLat;
}
export interface LineStringGeometry {
  type: "LineString";
  coordinates: LngLat[];
}
export interface Feature<G, P> {
  type: "Feature";
  geometry: G;
  properties: P;
}
export interface FeatureCollection<G, P> {
  type: "FeatureCollection";
  features: Feature<G, P>[];
}

export type StationCollection = FeatureCollection<
  PointGeometry,
  StationProperties
>;
export type SegmentCollection = FeatureCollection<
  LineStringGeometry,
  SegmentProperties
>;

// --- Track junction graph (doc02.05) ------------------------------------
// The topology the renderer needs to stitch segments where they meet or cross.
// Facts only — the pipeline computes *what is true* about the network (which edges
// meet, which cross, who has priority); the renderer owns *how* each kind is drawn
// (doc01.03). `seg` fields index SegmentCollection.features.

export interface EdgeEnd {
  seg: number;
  end: "start" | "end"; // which end of that segment touches the node
}

export type TrackNode =
  // Three or more edge-ends coincide with distinct outgoing directions: a real
  // split/merge whose gap between diverging ribbons the renderer fills with a gore.
  | { kind: "junction"; point: LngLat; ends: EdgeEnd[] }
  // Two unconnected segments cross in space (e.g. a line passing over another):
  // the renderer grade-separates them, drawing `over` above `under`.
  | { kind: "crossing"; point: LngLat; over: number; under: number };

export interface TrackGraph {
  nodes: TrackNode[];
}

// --- Linear-reference index (motion) ------------------------------------
// The web app lerps a Position Estimate along a Track by distance: given a
// train between two stops, find their `dist`, interpolate, then walk `points`
// via `cumDist`. Precomputed here so runtime touches no raw geometry.

export interface TrackStop {
  stopId: string; // directional stop_id, e.g. "127N"
  dist: number; // meters along the polyline from its start
}
export interface Track {
  routeId: string;
  direction: Direction;
  points: LngLat[];
  cumDist: number[]; // meters at each point; length === points.length
  stops: TrackStop[]; // ordered by dist
}
export interface TrackIndex {
  feedVersion: string | null; // from feed_info.txt, for provenance
  tracks: Track[];
}
