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
}

// v0 worker serves only the IRT numbered lines + 42 St shuttle (doc02.04). NYC
// colors by trunk, so a handful of hexes cover every Route we can see; anything
// else falls back to grey. Baking a route->color asset supersedes this later.
const ROUTE_COLOR: Record<string, string> = {
  "1": "#EE352E",
  "2": "#EE352E",
  "3": "#EE352E",
  "4": "#00933C",
  "5": "#00933C",
  "6": "#00933C",
  "7": "#B933AD",
  GS: "#808183",
  S: "#808183",
};
const FALLBACK_COLOR = "#9a9a9a";

const trackKey = (routeId: string, direction: string) =>
  `${routeId}|${direction}`;

export function indexTracks(index: TrackIndex): Map<string, Track> {
  const m = new Map<string, Track>();
  for (const t of index.tracks) m.set(trackKey(t.routeId, t.direction), t);
  return m;
}

export function poseForTrip(
  trip: TripState,
  tracks: Map<string, Track>,
  nowMs: number,
): TrainPose | null {
  const track = tracks.get(trackKey(trip.routeId, trip.direction));
  if (!track) return null;

  const distByStop = new Map<string, number>();
  for (const s of track.stops) distByStop.set(s.stopId, s.dist);

  // Keyframes are (distance-along-track, time): the last known stop, then each
  // upcoming stop the track actually carries.
  const kf: { dist: number; t: number }[] = [];
  const d0 = distByStop.get(trip.lastKnownStop.stopId);
  if (d0 == null) return null;
  kf.push({ dist: d0, t: trip.lastKnownStop.at });
  for (const u of trip.upcoming) {
    const d = distByStop.get(u.stopId);
    if (d != null) kf.push({ dist: d, t: u.arrival });
  }

  const dist = distAt(kf, nowMs);
  return {
    tripId: trip.tripId,
    color: colorFor(trip.routeId),
    ...pointAt(track, dist),
  };
}

function colorFor(routeId: string): string {
  return ROUTE_COLOR[routeId] ?? FALLBACK_COLOR;
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
