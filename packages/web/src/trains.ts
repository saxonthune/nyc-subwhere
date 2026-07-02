// Live-train motion (doc02.04): turn each Trip's render frame into a drawable
// pose by interpolating along its baked Track. The worker ships lastKnownStop +
// upcoming keyframes; here we lerp a Position Estimate by wall-clock time between
// stops and read a point + travel bearing off the Track's polyline. Pure — the
// layer owns the meshes, main.ts owns the poll clock (doc01.03).

import type {
  LngLat,
  Track,
  TrackIndex,
  TripState,
} from "@nyc-subwhere/contract";

export interface TrainPose {
  tripId: string;
  color: string; // "#RRGGBB"
  lngLat: LngLat;
  bearing: number; // radians, atan2(north, east) of travel direction
  // The Board no longer trusts this position (doc01.03 "Uncertain Position"):
  // either the trip outran its keyframes before a fresher frame arrived, or the
  // worker flagged it stalled. The layer blinks these.
  uncertain: boolean;
}

// NYC colors by trunk, so a handful of hexes cover every Route. Baking a
// route->color asset supersedes this later.
const ROUTE_COLOR: Record<string, string> = {
  "1": "#EE352E",
  "2": "#EE352E",
  "3": "#EE352E",
  "4": "#00933C",
  "5": "#00933C",
  "6": "#00933C",
  "7": "#B933AD",
  A: "#0039A6",
  C: "#0039A6",
  E: "#0039A6",
  B: "#FF6319",
  D: "#FF6319",
  F: "#FF6319",
  M: "#FF6319",
  N: "#FCCC0A",
  Q: "#FCCC0A",
  R: "#FCCC0A",
  W: "#FCCC0A",
  G: "#6CBE45",
  J: "#996633",
  Z: "#996633",
  L: "#A7A9AC",
  // Shuttles (42 St, Franklin Av, Rockaway Park) all render dark grey.
  GS: "#808183",
  S: "#808183",
  SS: "#808183",
  FS: "#808183",
  H: "#808183",
  SI: "#0039A6",
  SIR: "#0039A6",
};
const FALLBACK_COLOR = "#9a9a9a";

// Feed routeId -> baked track-index routeId. The Rockaway Park shuttle reports
// "SS" in realtime but is baked as "H".
const ROUTE_ALIAS: Record<string, string> = { SS: "H" };
const bakedRouteId = (routeId: string) => ROUTE_ALIAS[routeId] ?? routeId;

const trackKey = (routeId: string, direction: string) =>
  `${routeId}|${direction}`;

export function indexTracks(index: TrackIndex): Map<string, Track> {
  const m = new Map<string, Track>();
  for (const t of index.tracks) m.set(trackKey(t.routeId, t.direction), t);
  return m;
}

export type DropCause = "noTrack" | "noStop";
export type TripResolution =
  | { ok: true; pose: TrainPose }
  | { ok: false; cause: DropCause; routeId: string };

// The trip's Position Estimate as a scalar distance along its Track, plus the
// Track itself. resolveTrip reads a point off this for rendering; the
// prediction-error metric compares two of these (same trip, two snapshots,
// one time) as a signed meters-along-track jump. `pastRunway` is true once
// nowMs has run beyond the last keyframe (or there is only one) — the position
// is then a hold, not an interpolation (doc01.03 "Uncertain Position").
export type DistResolution =
  | { ok: true; track: Track; dist: number; pastRunway: boolean }
  | { ok: false; cause: DropCause; routeId: string };

export function resolveDist(
  trip: TripState,
  tracks: Map<string, Track>,
  nowMs: number,
): DistResolution {
  const track = tracks.get(
    trackKey(bakedRouteId(trip.routeId), trip.direction),
  );
  if (!track) {
    return { ok: false, cause: "noTrack", routeId: trip.routeId };
  }

  const distByStop = new Map<string, number>();
  for (const s of track.stops) distByStop.set(s.stopId, s.dist);

  // Keyframes are (distance-along-track, time): the last known stop, then each
  // upcoming stop the track carries. A stop with a later departure than arrival
  // gets a second keyframe at the same distance — the train holds there for the
  // dwell instead of gliding through it (doc02.04), which is where the old
  // model ran ahead of reality.
  const kf: { dist: number; t: number }[] = [];
  const d0 = distByStop.get(trip.lastKnownStop.stopId);
  if (d0 == null) {
    return { ok: false, cause: "noStop", routeId: trip.routeId };
  }
  kf.push({ dist: d0, t: trip.lastKnownStop.at });
  for (const u of trip.upcoming) {
    const d = distByStop.get(u.stopId);
    if (d == null) continue;
    kf.push({ dist: d, t: u.arrival });
    if (u.departure != null && u.departure > u.arrival) {
      kf.push({ dist: d, t: u.departure });
    }
  }

  const pastRunway = kf.length === 1 || nowMs > kf[kf.length - 1].t;
  return { ok: true, track, dist: distAt(kf, nowMs), pastRunway };
}

export function resolveTrip(
  trip: TripState,
  tracks: Map<string, Track>,
  nowMs: number,
): TripResolution {
  const r = resolveDist(trip, tracks, nowMs);
  if (!r.ok) return r;
  return {
    ok: true,
    pose: {
      tripId: trip.tripId,
      color: colorFor(trip.routeId),
      uncertain: r.pastRunway || trip.status === "stalled",
      ...pointAt(r.track, r.dist),
    },
  };
}

// Express-diamond variants ("6X", "7X") share their trunk color, so strip a
// trailing X before the lookup.
function colorFor(routeId: string): string {
  return (
    ROUTE_COLOR[routeId] ??
    ROUTE_COLOR[routeId.replace(/X$/, "")] ??
    FALLBACK_COLOR
  );
}

// Interpolate distance from the keyframes, clamped to the runway ends. (The
// lost-runway blink for nowMs past the last keyframe is a later behavior; here
// the train simply holds at its last known stop.)
function distAt(kf: { dist: number; t: number }[], nowMs: number): number {
  const last = kf[kf.length - 1];
  if (kf.length === 1 || nowMs <= kf[0].t) return kf[0].dist;
  if (nowMs >= last.t) return last.dist;
  let i = 0;
  while (i < kf.length - 1 && nowMs > kf[i + 1].t) i++;
  const a = kf[i];
  const b = kf[i + 1];
  const f = (nowMs - a.t) / (b.t - a.t || 1);
  return a.dist + (b.dist - a.dist) * f;
}

// Walk the track polyline to a distance, returning the point and the bearing of
// the segment it lands on. cumDist[i] is meters to points[i]; find the bracketing
// segment and lerp within it.
function pointAt(
  track: Track,
  dist: number,
): { lngLat: LngLat; bearing: number } {
  const { points, cumDist } = track;
  const total = cumDist[cumDist.length - 1];
  const d = Math.max(0, Math.min(total, dist));
  let i = 0;
  while (i < cumDist.length - 2 && cumDist[i + 1] < d) i++;
  const a = points[i];
  const b = points[i + 1] ?? a;
  const f = (d - cumDist[i]) / (cumDist[i + 1] - cumDist[i] || 1);
  const lng = a[0] + (b[0] - a[0]) * f;
  const lat = a[1] + (b[1] - a[1]) * f;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const bearing = Math.atan2(b[1] - a[1], (b[0] - a[0]) * cosLat);
  return { lngLat: [lng, lat], bearing };
}
