// Stage 3.5: merge conforming (doc02.05). A branch track (e.g. D) that joins a trunk
// carrying a superset of its routes (D/N/R) is cut in GTFS so its end lands *short* of
// the trunk and at an angle — the renderer then draws a floor that never reaches the
// trunk, with a torn throat. Here the branch's tail is reshaped as a G1 (tangent-
// continuous) blend that ends exactly on the trunk centerline with the trunk's heading,
// so the two half-ribbons coincide at the join by construction. Facts stay in the
// canonical geometry: this mutates segments in place before the graph + assets are
// written, so crossings and picking see the conformed shape too. Meters throughout.

import type {
  LngLat,
  SegmentCollection,
  TrackMerge,
} from "@nyc-subwhere/contract";
import { projectNyc, unprojectNyc } from "./geo";

// A branch end within this of a superset trunk's centerline, and heading within
// MERGE_ANGLE of it, is a merge to conform (a steeper approach is a crossing, left
// alone). BLEND_M of the branch tail is reshaped into the join.
const MERGE_ATTACH_M = 35;
const MERGE_ANGLE_DEG = 45;
const BLEND_M = 55;

type Pt = [number, number];

interface Seg {
  i: number;
  m: Pt[];
  routes: Set<string>;
  dir: string;
}

export function conformMerges(segments: SegmentCollection): {
  conformed: number;
  merges: TrackMerge[];
} {
  const segs: Seg[] = segments.features.map((f, i) => ({
    i,
    m: f.geometry.coordinates.map(projectNyc),
    routes: new Set(f.properties.routes),
    dir: f.properties.direction,
  }));

  const merges: TrackMerge[] = [];
  for (const b of segs) {
    // Reshape either end that lands on a superset trunk. `atEnd` false = the start
    // vertex is the join, so reverse, reshape the tail, and reverse back.
    for (const atEnd of [true, false]) {
      const poly = atEnd ? b.m : [...b.m].reverse();
      const joinPt = poly[poly.length - 1];
      const inTan = unit(sub(joinPt, poly[poly.length - 2]));
      const t = findTrunk(b, joinPt, inTan, segs);
      if (!t) continue;
      const reshaped = blendTail(poly, t.attach, t.tan);
      if (!reshaped) continue;
      b.m = atEnd ? reshaped : reshaped.reverse();
      merges.push({ branch: b.i, trunk: t.ti, attach: unprojectNyc(t.attach) });
    }
  }

  for (const s of segs) {
    segments.features[s.i].geometry.coordinates = s.m.map(
      unprojectNyc,
    ) as LngLat[];
  }
  return { conformed: merges.length, merges };
}

// The trunk this branch end joins: a different segment, same direction, whose routes
// are a strict superset, whose centerline passes within MERGE_ATTACH_M of the end at a
// heading within MERGE_ANGLE of the branch's approach. Nearest such wins.
function findTrunk(
  b: Seg,
  joinPt: Pt,
  inTan: Pt,
  segs: Seg[],
): { attach: Pt; tan: Pt; ti: number } | null {
  let best: { attach: Pt; tan: Pt; ti: number; d: number } | null = null;
  for (const t of segs) {
    if (t.i === b.i || t.dir !== b.dir) continue;
    if (!strictSuperset(t.routes, b.routes)) continue;
    const np = nearestOnPoly(joinPt, t.m);
    if (np.d > MERGE_ATTACH_M) continue;
    const tan = orient(np.tan, inTan);
    if (dot(tan, inTan) < Math.cos((MERGE_ANGLE_DEG * Math.PI) / 180)) continue;
    if (!best || np.d < best.d)
      best = { attach: np.point, tan, ti: t.i, d: np.d };
  }
  return best;
}

// Reshape the last BLEND_M of a polyline into a cubic Hermite from the point BLEND_M
// back (keeping that heading) to `attach` with `tan`, so the tail meets the trunk
// tangentially. Returns null if the tail is already at the attach point (no-op merge).
function blendTail(poly: Pt[], attach: Pt, tan: Pt): Pt[] | null {
  const end = poly[poly.length - 1];
  if (dist(end, attach) < 1) return null;

  const cum = [0];
  for (let i = 1; i < poly.length; i++)
    cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  const cut = Math.max(0, total - BLEND_M);

  const kept: Pt[] = [];
  for (let i = 0; i < poly.length; i++) if (cum[i] < cut) kept.push(poly[i]);
  const p0 = pointAtArc(poly, cum, cut);
  const m0 = unit(sub(pointAtArc(poly, cum, Math.min(total, cut + 2)), p0));

  const chord = dist(p0, attach) || 1;
  const t0: Pt = [m0[0] * chord, m0[1] * chord];
  const t1: Pt = [tan[0] * chord, tan[1] * chord];

  const n = Math.max(6, Math.round(BLEND_M / 6));
  const out = [...kept, p0];
  for (let k = 1; k <= n; k++) {
    const s = k / n;
    out.push(hermite(p0, t0, attach, t1, s));
  }
  return out;
}

function hermite(p0: Pt, t0: Pt, p1: Pt, t1: Pt, s: number): Pt {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return [
    h00 * p0[0] + h10 * t0[0] + h01 * p1[0] + h11 * t1[0],
    h00 * p0[1] + h10 * t0[1] + h01 * p1[1] + h11 * t1[1],
  ];
}

function nearestOnPoly(p: Pt, poly: Pt[]): { point: Pt; tan: Pt; d: number } {
  let best = { point: poly[0], tan: [1, 0] as Pt, d: Number.POSITIVE_INFINITY };
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const bb = poly[i + 1];
    const dx = bb[0] - a[0];
    const dy = bb[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    let u = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    u = Math.min(1, Math.max(0, u));
    const point: Pt = [a[0] + u * dx, a[1] + u * dy];
    const d = dist(p, point);
    if (d < best.d) best = { point, tan: unit([dx, dy]), d };
  }
  return best;
}

function pointAtArc(poly: Pt[], cum: number[], arc: number): Pt {
  if (arc <= 0) return poly[0];
  const total = cum[cum.length - 1];
  if (arc >= total) return poly[poly.length - 1];
  let i = 1;
  while (cum[i] < arc) i++;
  const t = (arc - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [
    poly[i - 1][0] + t * (poly[i][0] - poly[i - 1][0]),
    poly[i - 1][1] + t * (poly[i][1] - poly[i - 1][1]),
  ];
}

function strictSuperset(a: Set<string>, b: Set<string>): boolean {
  if (a.size <= b.size) return false;
  for (const r of b) if (!a.has(r)) return false;
  return true;
}

function orient(tan: Pt, ref: Pt): Pt {
  return dot(tan, ref) < 0 ? [-tan[0], -tan[1]] : tan;
}
function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}
function dot(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}
function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function unit(a: Pt): Pt {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
}
