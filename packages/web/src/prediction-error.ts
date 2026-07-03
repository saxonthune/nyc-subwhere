// Prediction-error metric (doc02.04): the jump a train makes when a fresher
// frame re-anchors it IS the error of the previous frame's extrapolation. At
// each poll, evaluate the *previous* snapshot's keyframes at the *new* asOf
// (where the old data predicted the train would be) and compare, along the same
// Track, to where the new data places it. The signed gap in meters-along-track
// is one record's worth of "how wrong were we". Pure — main.ts owns the poll
// clock and ships records to the dev file sink (metrics.ts).

import type { Direction, RenderSnapshot, Track } from "@nyc-subwhere/contract";
import { resolveDist } from "./trains";

export interface TripError {
  tripId: string;
  routeId: string;
  dir: Direction;
  predDist: number; // old keyframes at new asOf, meters along track
  actualDist: number; // new keyframes at new asOf, meters along track
  err: number; // actualDist - predDist (signed); +ve = further along than predicted
  staleMs: number; // asOf - prev lastKnownStop.at: age of the prediction's anchor
  // Stations of the trip's track lying in (actualDist, predDist] — Stations the
  // OLD frame had already glided the train past that the fresh frame shows it had
  // not reached. This is the doc01.03 "Position Honesty" violation count: each one
  // is a false station passage. Zero when the old frame sat behind the fresh one.
  overshotStations: number;
}

export interface PredictionErrorRecord {
  v: 1;
  prevAsOf: number;
  asOf: number;
  dtMs: number;
  counts: {
    prevTrips: number;
    newTrips: number;
    matched: number;
    appeared: number;
    disappeared: number;
    lineSwitched: number;
  };
  meters: {
    mean: number;
    p50: number;
    p95: number;
    max: number;
    meanSigned: number;
  };
  byRoute: Record<
    string,
    { n: number; mean: number; p95: number; meanSigned: number }
  >;
  trips: TripError[];
}

export function predictionErrors(
  prev: RenderSnapshot,
  next: RenderSnapshot,
  tracks: Map<string, Track>,
): PredictionErrorRecord {
  const asOf = next.asOf;
  const prevById = new Map(prev.trips.map((t) => [t.tripId, t]));
  const nextIds = new Set(next.trips.map((t) => t.tripId));

  let appeared = 0;
  let lineSwitched = 0;
  const errors: TripError[] = [];

  for (const t of next.trips) {
    const p = prevById.get(t.tripId);
    if (!p) {
      appeared++;
      continue;
    }
    // Both frames scored at the SAME instant (new asOf): pred = extrapolation of
    // the old frame, actual = the fresh frame's own placement.
    const pred = resolveDist(p, tracks, asOf);
    const actual = resolveDist(t, tracks, asOf);
    if (!pred.ok || !actual.ok) continue;
    if (pred.track !== actual.track) {
      // Route/direction changed between snapshots — a line switch, not a
      // distance the two tracks share. Counted, but off the meters metric.
      lineSwitched++;
      continue;
    }
    let overshotStations = 0;
    for (const s of actual.track.stops) {
      if (s.dist > actual.dist && s.dist <= pred.dist) overshotStations++;
    }
    errors.push({
      tripId: t.tripId,
      routeId: t.routeId,
      dir: t.direction,
      predDist: pred.dist,
      actualDist: actual.dist,
      err: actual.dist - pred.dist,
      staleMs: asOf - p.lastKnownStop.at,
      overshotStations,
    });
  }

  let disappeared = 0;
  for (const id of prevById.keys()) if (!nextIds.has(id)) disappeared++;

  const abs = errors.map((e) => Math.abs(e.err));
  return {
    v: 1,
    prevAsOf: prev.asOf,
    asOf,
    dtMs: asOf - prev.asOf,
    counts: {
      prevTrips: prev.trips.length,
      newTrips: next.trips.length,
      matched: errors.length,
      appeared,
      disappeared,
      lineSwitched,
    },
    meters: {
      mean: mean(abs),
      p50: percentile(abs, 0.5),
      p95: percentile(abs, 0.95),
      max: abs.length ? Math.max(...abs) : 0,
      meanSigned: mean(errors.map((e) => e.err)),
    },
    byRoute: byRoute(errors),
    trips: errors,
  };
}

function byRoute(
  errors: TripError[],
): Record<
  string,
  { n: number; mean: number; p95: number; meanSigned: number }
> {
  const groups = new Map<string, TripError[]>();
  for (const e of errors) {
    const g = groups.get(e.routeId) ?? [];
    g.push(e);
    groups.set(e.routeId, g);
  }
  const out: Record<
    string,
    { n: number; mean: number; p95: number; meanSigned: number }
  > = {};
  for (const [routeId, es] of groups) {
    const abs = es.map((e) => Math.abs(e.err));
    out[routeId] = {
      n: es.length,
      mean: round(mean(abs)),
      p95: round(percentile(abs, 0.95)),
      meanSigned: mean(es.map((e) => e.err)),
    };
  }
  return out;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

// Nearest-rank on the sorted sample; q in [0,1].
function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return round(sorted[Math.max(0, i)]);
}

const round = (x: number) => Math.round(x * 10) / 10;
