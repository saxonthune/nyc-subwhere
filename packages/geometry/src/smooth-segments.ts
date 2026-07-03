// Stage 3d: centerline smoothing (doc02.07). GTFS shapes are coarse polylines (~10 m between
// vertices), so a curving track buffers into a faceted ribbon and its chevrons read as a
// squiggle. Chaikin corner-cutting rounds each bend toward a quadratic B-spline, staying
// inside the original hull (no overshoot, unlike an interpolating spline), so curves render
// as smooth arcs. Run after healing so the tangent-extended join is smoothed with everything
// else; the same smoothed centerline feeds the silhouette union and the caret fill, keeping
// outline and colour registered.

import type { SegmentCollection } from "@nyc-subwhere/contract";
import { projectNyc, unprojectNyc } from "./geo";

type Pt = [number, number];

const ITERATIONS = 2;
// Only cut a corner whose turn exceeds this; near-collinear vertices are kept so straight runs
// don't bloat with redundant points.
const MIN_TURN_RAD = (4 * Math.PI) / 180;
// Douglas–Peucker tolerance (metres) applied before smoothing. The heal-extension and taper
// stubs, plus sub-metre noise in the raw GTFS shapes, survive Chaikin as visible kinks (they
// are near-collinear, so the turn threshold keeps them); dropping any vertex within this
// distance of the chord removes them first. 1 m is negligible against the 26 m ribbon.
const SIMPLIFY_EPS_M = 1;

export function smoothSegments(segments: SegmentCollection): SegmentCollection {
  const features = segments.features.map((f) => {
    const coords = f.geometry.coordinates;
    if (coords.length < 3) return f;
    let pts = simplify(coords.map(projectNyc), SIMPLIFY_EPS_M);
    for (let it = 0; it < ITERATIONS; it++) pts = chaikin(pts);
    return {
      ...f,
      geometry: { ...f.geometry, coordinates: pts.map(unprojectNyc) },
    };
  });
  return { ...segments, features };
}

// Douglas–Peucker: keep the endpoints and any vertex whose perpendicular distance to the
// current chord exceeds eps, recursing on the two halves. Endpoints are preserved, so a
// healed/tapered tip is never dropped.
function simplify(pts: Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > a) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// One Chaikin pass: keep the endpoints, and replace each cut corner with the two points a
// quarter of the way toward its neighbours (0.75·b + 0.25·a and 0.75·b + 0.25·c).
function chaikin(pts: Pt[]): Pt[] {
  const n = pts.length;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    if (turn(a, b, c) < MIN_TURN_RAD) {
      out.push(b);
      continue;
    }
    out.push([b[0] + 0.25 * (a[0] - b[0]), b[1] + 0.25 * (a[1] - b[1])]);
    out.push([b[0] + 0.25 * (c[0] - b[0]), b[1] + 0.25 * (c[1] - b[1])]);
  }
  out.push(pts[n - 1]);
  return out;
}

function turn(a: Pt, b: Pt, c: Pt): number {
  const v1x = b[0] - a[0];
  const v1y = b[1] - a[1];
  const v2x = c[0] - b[0];
  const v2y = c[1] - b[1];
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  return Math.abs(Math.atan2(cross, dot));
}
