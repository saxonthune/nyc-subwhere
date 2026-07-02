// Stage 4: track junctions (doc02.05). Finds where two tracks cross at different
// grade — a transversal intersection in the *interior* of both segments (a merge, by
// contrast, meets at a shared endpoint) — then bakes the grade separation as a
// per-vertex elevation profile: the `over` segment ramps up over the crossing and
// back down along its own arc length, so the renderer lifts floor and walls together
// with no tear (doc01.03).

import type {
  LngLat,
  SegmentCollection,
  TrackCrossing,
  TrackGraph,
} from "@nyc-subwhere/contract";
import { projectNyc } from "./geo";

// An intersection within this of either segment's endpoint is a merge/branch throat,
// not a crossing — the two tracks join there rather than pass at different grade.
const ENDPOINT_EXCLUDE_M = 25;
// A crossing shallower than this is a near-parallel merge artifact, not a clean
// cross; skip it so it gets no grade-separation lift.
const CROSS_MIN_ANGLE_DEG = 20;
// Grade-separation ramp: the over segment rises this high at the crossing (clears the
// under wall tops, ~10 m) and eases back to grade over this arc-length each side, as a
// raised cosine so the profile is C1 (no kink in floor or walls). Meters.
const CROSS_LIFT_M = 20;
const CROSS_RAMP_M = 70;

type Pt = [number, number]; // meters

interface Seg {
  i: number;
  ll: LngLat[];
  m: Pt[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  routes: string[];
}

export function buildGraph(segments: SegmentCollection): TrackGraph {
  const segs: Seg[] = segments.features.map((f, i) => {
    const ll = f.geometry.coordinates;
    const m = ll.map(projectNyc);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [x, y] of m) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { i, ll, m, minX, minY, maxX, maxY, routes: f.properties.routes };
  });

  const crossings: TrackCrossing[] = [];
  for (let a = 0; a < segs.length; a++) {
    for (let b = a + 1; b < segs.length; b++) {
      const sa = segs[a];
      const sb = segs[b];
      if (
        sa.maxX < sb.minX ||
        sb.maxX < sa.minX ||
        sa.maxY < sb.minY ||
        sb.maxY < sa.minY
      )
        continue;
      const hit = firstCrossing(sa, sb);
      if (!hit) continue;
      const [over, under] = priority(sa, sb);
      crossings.push({ point: hit, over, under });
    }
  }

  const elevation = segs.map((s) => new Array<number>(s.m.length).fill(0));
  for (const c of crossings) {
    liftOverProfile(segs[c.over], projectNyc(c.point), elevation[c.over]);
  }

  const partner = pairCorridors(segs, segments);
  return { crossings, elevation, partner };
}

// Pair each segment with its antiparallel other-direction half: same route set,
// opposite direction, endpoints reversed within PAIR_MATCH_M. The renderer fuses a pair
// into one full-width ribbon (no centerline seam). One-directional segments get -1.
const PAIR_MATCH_M = 30;
function pairCorridors(segs: Seg[], segments: SegmentCollection): number[] {
  const partner = new Array<number>(segs.length).fill(-1);
  const dir = segments.features.map((f) => f.properties.direction);
  const key = segs.map((s) => [...s.routes].sort().join(","));
  const byKey = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const k = `${key[i]}|${dir[i]}`;
    const g = byKey.get(k);
    if (g) g.push(i);
    else byKey.set(k, [i]);
  });
  const start = (s: Seg) => s.m[0];
  const finish = (s: Seg) => s.m[s.m.length - 1];
  for (let i = 0; i < segs.length; i++) {
    if (dir[i] !== "N" || partner[i] >= 0) continue;
    const cands = byKey.get(`${key[i]}|S`) ?? [];
    let best = -1;
    let bestScore = PAIR_MATCH_M * 2;
    for (const j of cands) {
      if (partner[j] >= 0) continue;
      const score =
        dist(start(segs[i]), finish(segs[j])) +
        dist(finish(segs[i]), start(segs[j]));
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0) {
      partner[i] = best;
      partner[best] = i;
    }
  }
  return partner;
}

// Ramp the `over` segment up around a crossing, in the segment's own arc-length domain
// (not radial distance) so the whole cross-section at each vertex moves as one unit.
// The crossing's arc position is the nearest point on the polyline; each vertex within
// CROSS_RAMP_M of it takes a raised-cosine lift, max-combined with any other crossing.
function liftOverProfile(seg: Seg, point: Pt, out: number[]): void {
  const cum = [0];
  for (let i = 1; i < seg.m.length; i++)
    cum.push(cum[i - 1] + dist(seg.m[i - 1], seg.m[i]));

  let bestD = Number.POSITIVE_INFINITY;
  let crossArc = 0;
  for (let i = 0; i < seg.m.length - 1; i++) {
    const { d, t } = projPointSeg(point, seg.m[i], seg.m[i + 1]);
    if (d < bestD) {
      bestD = d;
      crossArc = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }

  for (let i = 0; i < seg.m.length; i++) {
    const dd = Math.abs(cum[i] - crossArc);
    if (dd >= CROSS_RAMP_M) continue;
    const h =
      CROSS_LIFT_M * 0.5 * (1 + Math.cos((Math.PI * dd) / CROSS_RAMP_M));
    if (h > out[i]) out[i] = h;
  }
}

// Distance from p to segment a-b and the clamped parameter t of the foot along a-b.
function projPointSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return { d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}

// The first transversal interior intersection of two segments: away from every
// endpoint (else it is a merge) and steeper than the min angle (else near-parallel).
function firstCrossing(sa: Seg, sb: Seg): LngLat | null {
  for (let i = 0; i < sa.m.length - 1; i++) {
    const a1 = sa.m[i];
    const a2 = sa.m[i + 1];
    for (let j = 0; j < sb.m.length - 1; j++) {
      const b1 = sb.m[j];
      const b2 = sb.m[j + 1];
      const t = segIntersectT(a1, a2, b1, b2);
      if (t == null) continue;
      const x = a1[0] + t * (a2[0] - a1[0]);
      const y = a1[1] + t * (a2[1] - a1[1]);
      const p: Pt = [x, y];
      if (nearEndpoint(p, sa) || nearEndpoint(p, sb)) continue;
      if (angleBetween(a1, a2, b1, b2) < (CROSS_MIN_ANGLE_DEG * Math.PI) / 180)
        continue;
      const p0 = sa.ll[i];
      const p1 = sa.ll[i + 1];
      return [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
    }
  }
  return null;
}

function nearEndpoint(p: Pt, s: Seg): boolean {
  return (
    dist(p, s.m[0]) <= ENDPOINT_EXCLUDE_M ||
    dist(p, s.m[s.m.length - 1]) <= ENDPOINT_EXCLUDE_M
  );
}

// Busier segment (more routes, then longer route list, then lexicographic) goes on
// top. A stable rule, not a semantic claim about real elevation.
function priority(sa: Seg, sb: Seg): [number, number] {
  const ka = sa.routes.length;
  const kb = sb.routes.length;
  if (ka !== kb) return ka > kb ? [sa.i, sb.i] : [sb.i, sa.i];
  const ja = sa.routes.join(",");
  const jb = sb.routes.join(",");
  return ja <= jb ? [sa.i, sb.i] : [sb.i, sa.i];
}

function segIntersectT(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number | null {
  const rx = a2[0] - a1[0];
  const ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0];
  const sy = b2[1] - b1[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = b1[0] - a1[0];
  const qpy = b1[1] - a1[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

function angleBetween(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  const ax = a2[0] - a1[0];
  const ay = a2[1] - a1[1];
  const bx = b2[0] - b1[0];
  const by = b2[1] - b1[1];
  const dot = ax * bx + ay * by;
  const la = Math.hypot(ax, ay) || 1;
  const lb = Math.hypot(bx, by) || 1;
  return Math.acos(Math.min(1, Math.max(-1, Math.abs(dot) / (la * lb))));
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
