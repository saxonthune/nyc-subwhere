// Stage 4b: conform the motion index to the rendered network.
//
// buildTracks lays each route's motion polyline on its raw per-route GTFS shape.
// The display segments, though, are merged (merge-corridors.ts): where two
// distinct alignments run parallel far enough — the Manhattan Bridge carries
// B/D and N/Q ~22 m apart for ~2.7 km — they collapse to ONE drawn ribbon per
// direction. A train interpolated along the raw shape then floats ~22 m off the
// tube it is supposed to ride, because the tube follows the kept representative,
// not that route's own rails.
//
// This pass snaps each track onto the geometry actually drawn for it: densify the
// spine, and move every vertex onto the nearest rendered segment that (a) carries
// this route and (b) runs codirectionally. Candidates are restricted to segments
// carrying the route, so a track can only slide onto its own drawn tube — never
// onto a distinct parallel line (Times Sq 7 Av vs Broadway ~9 m) that carries
// other routes. The heading gate distinguishes the two antiparallel ribbons of a
// merged corridor. Where a route's raw shape already is the drawn geometry (every
// unmerged span), the nearest carrying sample sits at ~0 m and nothing moves.

import type { LngLat, SegmentCollection, Track } from "@nyc-subwhere/contract";
import { cumulative, projectNyc, round6, unprojectNyc } from "./geo";

const SPINE_STEP_M = 8; // densify the track spine before snapping
const TARGET_STEP_M = 5; // densify segment samples to snap onto
// Max lateral snap. Generous because candidates are limited to segments carrying
// the route — only the route's own drawn geometry (0 m) or a merged ribbon it is
// part of (the bridge, ~22 m) qualifies, never a foreign parallel line.
const SNAP_MAX_M = 40;
// Codirectional gate: reject a candidate whose local heading is more than this off
// the spine's, so a track snaps to the matching side of an antiparallel corridor,
// not its opposite-direction twin.
const SNAP_BEARING_COS = Math.cos((50 * Math.PI) / 180);

interface Sample {
  x: number;
  y: number;
  ux: number;
  uy: number;
  feat: number;
}

// Densify a polyline in projected meters into evenly spaced points, each carrying
// its arc-length along the input and the unit heading of the piece it lies on.
function densify(
  coords: LngLat[],
  step: number,
): { pts: [number, number][]; arc: number[]; head: [number, number][] } {
  const proj = coords.map(projectNyc);
  const pts: [number, number][] = [];
  const arc: number[] = [];
  const head: [number, number][] = [];
  let acc = 0;
  for (let i = 0; i < proj.length - 1; i++) {
    const [ax, ay] = proj[i];
    const [bx, by] = proj[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    for (let d = 0; d < len; d += step) {
      pts.push([ax + ux * d, ay + uy * d]);
      arc.push(acc + d);
      head.push([ux, uy]);
    }
    acc += len;
  }
  const last = proj[proj.length - 1];
  if (last) {
    pts.push([last[0], last[1]]);
    arc.push(acc);
    head.push(head[head.length - 1] ?? [1, 0]);
  }
  return { pts, arc, head };
}

// Old arc-length `d` on the raw spine -> arc-length on the snapped spine, via the
// 1:1 correspondence of densified vertices (both arrays are that same walk).
function remapDist(d: number, rawArc: number[], newCum: number[]): number {
  if (d <= rawArc[0]) return newCum[0];
  const n = rawArc.length;
  if (d >= rawArc[n - 1]) return newCum[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rawArc[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = rawArc[hi] - rawArc[lo] || 1;
  const t = (d - rawArc[lo]) / span;
  return newCum[lo] + (newCum[hi] - newCum[lo]) * t;
}

export function conformTracks(
  tracks: Track[],
  segments: SegmentCollection,
): Track[] {
  // Build the snap target: densify every drawn segment into headed samples in a
  // spatial hash, and record which routes each segment carries.
  const featRoutes: Set<string>[] = [];
  const samples: Sample[] = [];
  const carriers = new Set<string>();
  segments.features.forEach((f, feat) => {
    const routes = new Set(f.properties.routes);
    featRoutes.push(routes);
    for (const r of routes) carriers.add(r);
    const proj = f.geometry.coordinates.map(projectNyc);
    for (let i = 0; i < proj.length - 1; i++) {
      const [ax, ay] = proj[i];
      const [bx, by] = proj[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const ux = dx / len;
      const uy = dy / len;
      for (let d = 0; d < len; d += TARGET_STEP_M) {
        samples.push({ x: ax + ux * d, y: ay + uy * d, ux, uy, feat });
      }
    }
  });

  const cell = (v: number) => Math.floor(v / SNAP_MAX_M);
  const grid = new Map<string, number[]>();
  samples.forEach((s, idx) => {
    const key = `${cell(s.x)}:${cell(s.y)}`;
    (grid.get(key) ?? grid.set(key, []).get(key))?.push(idx);
  });

  // Nearest carrying, codirectional sample to `p`, subject to not sitting behind
  // `prev` along the heading. Nearest-point snapping alone is not arc-monotonic:
  // near a junction the closest carrying sample for the next spine point can lie
  // behind the last, which folds the polyline back on itself (a 180° spike). The
  // forward gate rejects those, so the snapped track only ever advances.
  const snap = (
    p: [number, number],
    prev: [number, number],
    hx: number,
    hy: number,
    routeId: string,
  ): [number, number] | null => {
    const cx = cell(p[0]);
    const cy = cell(p[1]);
    let best: Sample | null = null;
    let bestD2 = SNAP_MAX_M ** 2;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const si of grid.get(`${gx}:${gy}`) ?? []) {
          const s = samples[si];
          if (!featRoutes[s.feat].has(routeId)) continue;
          if (hx * s.ux + hy * s.uy < SNAP_BEARING_COS) continue;
          if ((s.x - prev[0]) * hx + (s.y - prev[1]) * hy < -SPINE_STEP_M)
            continue;
          const d2 = (s.x - p[0]) ** 2 + (s.y - p[1]) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = s;
          }
        }
      }
    }
    return best ? [best.x, best.y] : null;
  };

  return tracks.map((track) => {
    // A route with no drawn segments (peak-express diamonds are excluded from
    // display geometry) has nothing to conform to — leave its raw motion track.
    if (!carriers.has(track.routeId)) return track;

    const { pts, arc, head } = densify(track.points, SPINE_STEP_M);
    const newProj: [number, number][] = [];
    let prev = pts[0];
    for (let i = 0; i < pts.length; i++) {
      const snapped =
        snap(pts[i], prev, head[i][0], head[i][1], track.routeId) ?? pts[i];
      newProj.push(snapped);
      prev = snapped;
    }
    const points = newProj.map((m) => {
      const [lng, lat] = unprojectNyc(m);
      return [round6(lng), round6(lat)] as LngLat;
    });
    const cum = cumulative(points);
    return {
      routeId: track.routeId,
      direction: track.direction,
      points,
      cumDist: cum.map((d) => Math.round(d)),
      stops: track.stops.map((s) => ({
        stopId: s.stopId,
        dist: Math.round(remapDist(s.dist, arc, cum)),
      })),
    };
  });
}
