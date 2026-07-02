// Live-train motion (doc02.04): turn each Trip's render frame into a drawable
// pose by interpolating along its baked Track. The worker ships lastKnownStop +
// upcoming keyframes; here we lerp a Position Estimate by wall-clock time between
// stops and read a point + travel bearing off the Track's polyline. Pure — the
// layer owns the meshes, main.ts owns the poll clock (doc01.03).

import type {
  LngLat,
  RenderSnapshot,
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

// How far short of the next, unreached Station a train holds (doc01.03 "Position
// Honesty"): the render may run ahead of the train's true point along the Segment
// but must not reach the platform until a fresher frame observes arrival there.
// Roughly a train length, so the gap reads as "approaching", not "arrived".
const STATION_HOLD_MARGIN_M = 25;

export type DropCause = "noTrack" | "noStop";
export type TripResolution =
  | { ok: true; pose: TrainPose }
  | { ok: false; cause: DropCause; routeId: string };

// One resolved travel segment for a Trip: from the last OBSERVED station to the
// next Station it is approaching but has not been observed to reach. The runway is
// exactly this one segment (doc01.03 "Position Honesty"): stops beyond `B` are not
// interpolated toward — we cannot assert the train reached even the one in front.
// `cap` is the honesty bound, a short margin short of the unreached Station.
// Distances are meters along `track`; times are epoch ms.
interface Segment {
  track: Track;
  fromDist: number; // last observed station
  fromT: number;
  toDist: number; // next station (raw); == fromDist when none is resolvable
  toT: number;
  cap: number; // hold-short bound: toDist - margin, floored at fromDist
  hasNext: boolean;
}

type SegmentResolution =
  | { ok: true; seg: Segment }
  | { ok: false; cause: DropCause; routeId: string };

function segmentOf(
  trip: TripState,
  tracks: Map<string, Track>,
): SegmentResolution {
  const track = tracks.get(
    trackKey(bakedRouteId(trip.routeId), trip.direction),
  );
  if (!track) return { ok: false, cause: "noTrack", routeId: trip.routeId };

  const distByStop = new Map<string, number>();
  for (const s of track.stops) distByStop.set(s.stopId, s.dist);

  const fromDist = distByStop.get(trip.lastKnownStop.stopId);
  if (fromDist == null) {
    return { ok: false, cause: "noStop", routeId: trip.routeId };
  }

  // The next resolvable upcoming Station bounds the runway.
  let toDist = fromDist;
  let toT = trip.lastKnownStop.at;
  let hasNext = false;
  for (const u of trip.upcoming) {
    const d = distByStop.get(u.stopId);
    if (d == null) continue;
    toDist = d;
    toT = u.arrival;
    hasNext = true;
    break;
  }

  const cap = Math.max(fromDist, toDist - STATION_HOLD_MARGIN_M);
  return {
    ok: true,
    seg: {
      track,
      fromDist,
      fromT: trip.lastKnownStop.at,
      toDist,
      toT,
      cap,
      hasNext,
    },
  };
}

// Honest position along the one segment at `nowMs`: glide from the observed
// station toward the next by wall-clock, but never past the hold-short cap.
function segPos(seg: Segment, nowMs: number): number {
  let d: number;
  if (!seg.hasNext || nowMs <= seg.fromT) d = seg.fromDist;
  else if (nowMs >= seg.toT) d = seg.toDist;
  else
    d =
      seg.fromDist +
      ((seg.toDist - seg.fromDist) * (nowMs - seg.fromT)) /
        (seg.toT - seg.fromT || 1);
  return Math.min(d, seg.cap);
}

// The trip's Position Estimate as a scalar distance along its Track, plus the
// Track itself. This is the STATELESS one-frame estimate: the prediction-error
// metric compares two of these (same trip, two snapshots, one time) as a signed
// meters-along-track jump. The Board itself renders the stateful TripEstimator
// below, which folds successive frames together. `pastRunway` is true once nowMs
// has run past the segment's predicted arrival (or no next station is known): the
// position is then a hold-short, not a glide (doc01.03 "Uncertain Position").
export type DistResolution =
  | { ok: true; track: Track; dist: number; pastRunway: boolean }
  | { ok: false; cause: DropCause; routeId: string };

export function resolveDist(
  trip: TripState,
  tracks: Map<string, Track>,
  nowMs: number,
): DistResolution {
  const r = segmentOf(trip, tracks);
  if (!r.ok) return r;
  const { seg } = r;
  const pastRunway = !seg.hasNext || nowMs > seg.toT;
  return { ok: true, track: seg.track, dist: segPos(seg, nowMs), pastRunway };
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

interface Basis {
  tripId: string;
  track: Track;
  color: string;
  fromDist: number;
  fromT: number;
  toDist: number; // the hold-short cap
  toT: number;
  hasNext: boolean;
  stalled: boolean;
}

// Where the estimate places a train at `nowMs`: glide fromDist -> toDist (the
// hold-short cap) over fromT -> toT, holding at either end.
function basisPos(b: Basis, nowMs: number): number {
  if (nowMs <= b.fromT) return b.fromDist;
  if (!b.hasNext || nowMs >= b.toT) return b.toDist;
  const f = (nowMs - b.fromT) / (b.toT - b.fromT || 1);
  return b.fromDist + (b.toDist - b.fromDist) * f;
}

// One Trip's reconciliation at a poll (doc02.06): how the estimate compared to the
// fresh frame, and how far it visibly moved when re-based. Signs — `drift` positive
// means the estimate had run AHEAD of the freshly-observed position (reality);
// `jump` positive means the re-base nudged the rendered train forward.
export interface ReconcileTrip {
  tripId: string;
  routeId: string;
  drift: number; // shown − fresh: the estimate's error vs reality, meters
  jump: number; // rebased − shown: the visible teleport at re-base, meters
}

// Per-poll estimator report, logged alongside the prediction-error metric. `drift`
// answers "how close is what we render to the freshest observation" (the visual
// rules vs reality); `jump` answers "how much did trains visibly teleport" (the
// re-base discontinuity the rider actually sees). Only trips present before AND
// after the poll on the same track are reconciled; new/track-switched trips just
// initialize and are counted in `appeared`.
export interface EstimatorReport {
  asOf: number;
  matched: number;
  appeared: number;
  drift: { mean: number; p50: number; p95: number; signed: number };
  jump: {
    mean: number;
    p50: number;
    p95: number;
    max: number;
    signed: number;
    moved: number; // trips whose render teleported more than a meter
  };
  trips: ReconcileTrip[];
}

// Stateful, forward-only position estimator (doc02.06 "Reconciling frames"). The
// stateless resolveDist recomputes absolute position from each frame's noisy
// anchor + predicted ETA, so ETA jitter snaps trains backward. The estimator
// instead treats each snapshot as a CORRECTION to the position already on screen:
// it re-bases every Trip's glide to start from where it is being rendered right
// now, heading to its next unreached Station. A Trip therefore only moves forward
// (a delay reads as deceleration, not a rewind) except for two honest corrections
// — snapping forward onto a newly OBSERVED station, and pulling back to the
// hold-short cap if it had over-glided. Continuous by construction: at the instant
// of re-basing, from_dist equals the shown position, so only the future pace
// changes, not the point.
export class TripEstimator {
  private readonly bases = new Map<string, Basis>();
  // "cause:routeId" -> count, from the last ingest, for the Advanced Stats tally.
  readonly drops = new Map<string, number>();

  get count(): number {
    return this.bases.size;
  }

  ingest(
    snapshot: RenderSnapshot,
    tracks: Map<string, Track>,
    nowMs: number,
  ): EstimatorReport {
    this.drops.clear();
    const live = new Set<string>();
    const recon: ReconcileTrip[] = [];
    let appeared = 0;
    for (const trip of snapshot.trips) {
      const r = segmentOf(trip, tracks);
      if (!r.ok) {
        const key = `${r.cause}:${r.routeId}`;
        this.drops.set(key, (this.drops.get(key) ?? 0) + 1);
        continue;
      }
      const { seg } = r;
      live.add(trip.tripId);
      const prev = this.bases.get(trip.tripId);
      const reconciled = prev != null && prev.track === seg.track;
      // This frame's own honest placement is the reality proxy; `shown` is where we
      // are actually rendering the train (the running estimate, or the fresh
      // placement for a new/track-switched trip).
      const fresh = segPos(seg, nowMs);
      const shown = reconciled ? basisPos(prev as Basis, nowMs) : fresh;
      // Never backward below what we show, never below the observed station, never
      // past the hold-short cap. This is exactly what the train renders at right
      // after the re-base, so its gap from `shown` is the visible jump.
      const fromDist = Math.min(Math.max(shown, seg.fromDist), seg.cap);
      if (reconciled) {
        recon.push({
          tripId: trip.tripId,
          routeId: trip.routeId,
          drift: shown - fresh,
          jump: fromDist - shown,
        });
      } else {
        appeared++;
      }
      this.bases.set(trip.tripId, {
        tripId: trip.tripId,
        track: seg.track,
        color: colorFor(trip.routeId),
        fromDist,
        fromT: nowMs,
        toDist: seg.cap,
        toT: seg.toT,
        hasNext: seg.hasNext,
        stalled: trip.status === "stalled",
      });
    }
    for (const id of [...this.bases.keys()]) {
      if (!live.has(id)) this.bases.delete(id);
    }
    return estimatorReport(nowMs, recon, appeared);
  }

  poses(nowMs: number): TrainPose[] {
    const out: TrainPose[] = [];
    for (const b of this.bases.values()) {
      const uncertain = b.stalled || !b.hasNext || nowMs > b.toT;
      out.push({
        tripId: b.tripId,
        color: b.color,
        uncertain,
        ...pointAt(b.track, basisPos(b, nowMs)),
      });
    }
    return out;
  }
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

function estimatorReport(
  asOf: number,
  recon: ReconcileTrip[],
  appeared: number,
): EstimatorReport {
  const driftAbs = recon.map((r) => Math.abs(r.drift));
  const jumpAbs = recon.map((r) => Math.abs(r.jump));
  return {
    asOf,
    matched: recon.length,
    appeared,
    drift: {
      mean: avg(driftAbs),
      p50: pctl(driftAbs, 0.5),
      p95: pctl(driftAbs, 0.95),
      signed: avg(recon.map((r) => r.drift)),
    },
    jump: {
      mean: avg(jumpAbs),
      p50: pctl(jumpAbs, 0.5),
      p95: pctl(jumpAbs, 0.95),
      max: jumpAbs.length ? round1(Math.max(...jumpAbs)) : 0,
      signed: avg(recon.map((r) => r.jump)),
      moved: recon.filter((r) => Math.abs(r.jump) > 1).length,
    },
    trips: recon,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function pctl(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return round1(sorted[Math.max(0, i)]);
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
