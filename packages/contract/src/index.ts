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

// --- Bike share live frame (doc02.09) ------------------------------------
// Citi Bike GBFS, trimmed and disambiguated the same way as the subway frame
// above: the read path serves these straight from KV, never touching GBFS.

/** Live per-dock counts, trimmed from GBFS station_status (doc02.09). */
export interface BikeStationStatus {
  stationId: string;
  /** num_ebikes_available, verbatim. */
  ebikes: number;
  /** num_bikes_available minus ebikes — GBFS's total includes ebikes. */
  classicBikes: number;
  docks: number;
  bikesDisabled: number;
  docksDisabled: number;
  renting: boolean;
  returning: boolean;
}

export interface BikeSnapshot {
  asOf: EpochMs;
  stations: BikeStationStatus[];
}

/** Per-dock identity from GBFS station_information; changes seasonally. */
export interface BikeStationInfo {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number;
}

export interface BikeStationsIndex {
  asOf: EpochMs;
  stations: BikeStationInfo[];
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
  // Platform signage for each direction, derived from the MTA Subway Stations
  // dataset by pairing the compass label with the terminal borough(s) of serving
  // routes, e.g. "Uptown & The Bronx" / "Downtown & Brooklyn" — the rider-facing
  // name for N / S. Absent when the build had no labels file or the station
  // wasn't in it.
  northLabel?: string;
  southLabel?: string;
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

// --- Track junctions (doc02.07) -----------------------------------------
// Where two tracks overlap (a crossing or a sustained near-parallel run). Facts only —
// the pipeline finds the overlaps and who passes over, and assigns each segment a constant
// grade level so overlapping floors resolve by depth rather than z-fighting.

export interface TrackCrossing {
  point: LngLat;
  over: number; // segment raised over the crossing
  under: number; // segment passing beneath
}

// One grade level's baked fill triangles (doc02.07): the colored caret floor, triangulated in
// the geometry bake so the renderer uploads it verbatim instead of rebuilding ribbon geometry.
// Flat arrays, one entry per triangle vertex (3 per triangle):
//   position  [lng, lat] pairs — the renderer projects to its meter frame and seats at surfaceY
//   along     arc length from the corridor's south end   → caret shader aV
//   across    signed offset from the centerline, ±halfWidth → caret shader aU
//   segId     the owning segment index → palette (segment colors) and pick-back to the segment
// One group per grade level; the renderer draws each with a depth offset (polygonOffset ∝
// -level) so higher grades win the depth test where floors overlap.
export interface TrackFillGroup {
  level: number;
  position: number[]; // 2 numbers per vertex
  along: number[]; // 1 per vertex
  across: number[]; // 1 per vertex
  segId: number[]; // 1 per vertex
}
export interface TrackFill {
  groups: TrackFillGroup[];
}

export interface TrackGraph {
  crossings: TrackCrossing[];
  // The colored caret floors, baked as triangles grouped by grade level (doc02.07). Derived
  // from the same per-corridor ribbon edges as `silhouette`, so fill and outline cannot drift.
  fill: TrackFill;
  // The dissolved network outline (doc02.07): every corridor centerline buffered by the
  // half-ribbon width and boolean-unioned, so merges/branches tile with no seam. Each entry is
  // one polygon as [outerRing, ...holeRings]; the renderer extrudes each ring into a platform
  // edge. Built in projected meters, stored as LngLat.
  silhouette: LngLat[][][];
}

// --- Debug graph (doc02.07) ---------------------------------------------
// Optional inspection artifact the pipeline publishes alongside the baked network: named layers
// of polylines the web app can draw as skinny 3D pipes to see the geometry at intermediate
// pipeline stages (e.g. corridor centerlines before vs after junction synthesis). Never consumed
// by the live app path; a missing file just means no debug views are offered.

export interface DebugPolyline {
  coordinates: LngLat[];
  color: string;
}
export interface DebugLayer {
  id: string;
  label: string; // menu-facing name
  lines: DebugPolyline[];
}
export interface DebugGraph {
  layers: DebugLayer[];
}

// --- Street grid (Bike View backdrop) ------------------------------------
// The baked NYC street network (build-streets.ts, from an OpenStreetMap
// extract): polylines grouped into tiers by road class, so the renderer can
// hide the small-street tiers when zoomed out. Tier order is fixed, largest
// roads first: 0 = motorway/trunk, 1 = primary/secondary, 2 = local streets.

export interface StreetGrid {
  tiers: LngLat[][][];
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
