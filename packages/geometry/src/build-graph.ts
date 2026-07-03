// Stage 4: track junctions (doc02.07). Finds where two tracks overlap — a true crossing or
// a sustained near-parallel run — decides which passes over (busier route-set on top), and
// assigns each segment a *constant* grade level: one above every segment it is over, via a
// longest-path level over the overlap graph. The renderer draws higher levels in front, so
// overlapping floors resolve in the depth buffer with no z-fighting and no geometric bump.

import type {
  LngLat,
  SegmentCollection,
  TrackCrossing,
  TrackGraph,
} from "@nyc-subwhere/contract";
import { projectNyc } from "./geo";

// An intersection within this of either segment's endpoint is a merge/branch throat.
// Kept small so merges (which the silhouette union tiles) still register a grade step and
// don't z-fight, while genuine end-to-end joins at stations don't.
const ENDPOINT_EXCLUDE_M = 12;
// A crossing shallower than this is treated as a near-parallel artifact and skipped.
const CROSS_MIN_ANGLE_DEG = 8;
// Overlap leveling: two corridors whose centerlines run within this of each other (their
// half-width HALF_WIDTH_M=26 ribbons overlap) for at least OVERLAP_MIN_M of length, but
// never actually cross, still get a grade step so their floors don't z-fight along the
// shared run (near-parallel express/local). Meters.
const OVERLAP_DIST_M = 36;
const OVERLAP_MIN_M = 40;
// Cap the grade stack (a deep overlap chain would otherwise pile up into many depth-offset
// layers); beyond the cap, rare same-level overlaps just z-resolve arbitrarily.
const MAX_LEVEL = 4;

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

export function buildGraph(
  segments: SegmentCollection,
): Omit<TrackGraph, "merges" | "silhouette" | "taper"> {
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

  // Grade relations (over must sit above under): a true crossing, or a sustained
  // near-parallel overlap between two different-route corridors that never actually cross.
  // Both feed the level DAG so any pair whose ribbons overlap gets separated in depth.
  const crossings: TrackCrossing[] = [];
  const relations: [number, number][] = [];
  for (let a = 0; a < segs.length; a++) {
    for (let b = a + 1; b < segs.length; b++) {
      const sa = segs[a];
      const sb = segs[b];
      if (
        sa.maxX < sb.minX - OVERLAP_DIST_M ||
        sb.maxX < sa.minX - OVERLAP_DIST_M ||
        sa.maxY < sb.minY - OVERLAP_DIST_M ||
        sb.maxY < sa.minY - OVERLAP_DIST_M
      )
        continue;
      const hit = firstCrossing(sa, sb);
      if (hit) {
        const [over, under] = priority(sa, sb);
        crossings.push({ point: hit, over, under });
        relations.push([over, under]);
        continue;
      }
      if (sameRoutes(sa, sb)) continue;
      if (overlapLength(sa, sb, OVERLAP_DIST_M) >= OVERLAP_MIN_M) {
        const [over, under] = priority(sa, sb);
        relations.push([over, under]);
      }
    }
  }

  // Longest-path grade level: over must sit above under, so level[over] ≥ level[under] + 1.
  // Relax to a fixed point (the priority order is total, so the over→under graph is acyclic
  // and this converges). Height is level·step, held constant along each segment.
  const level = new Array<number>(segs.length).fill(0);
  for (let iter = 0; iter < segs.length; iter++) {
    let changed = false;
    for (const [over, under] of relations) {
      if (level[over] < level[under] + 1) {
        level[over] = level[under] + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const grade = level.map((l) => Math.min(l, MAX_LEVEL));

  const partner = pairCorridors(segs, segments);
  return { crossings, grade, partner };
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

function sameRoutes(sa: Seg, sb: Seg): boolean {
  if (sa.routes.length !== sb.routes.length) return false;
  const a = [...sa.routes].sort();
  const b = [...sb.routes].sort();
  return a.every((r, i) => r === b[i]);
}

// Arc-length of sa that runs within maxDist of sb's polyline — how far the two ribbons
// overlap side by side. Approximated by summing sa's edges whose midpoint is within range.
function overlapLength(sa: Seg, sb: Seg, maxDist: number): number {
  const maxD2 = maxDist * maxDist;
  let len = 0;
  for (let i = 0; i < sa.m.length - 1; i++) {
    const a = sa.m[i];
    const b = sa.m[i + 1];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointPolyD2(mid, sb.m) <= maxD2) len += dist(a, b);
  }
  return len;
}

function pointPolyD2(p: Pt, poly: Pt[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = segD2(p, poly[i], poly[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function segD2(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.min(1, Math.max(0, t));
  const ex = p[0] - (a[0] + t * dx);
  const ey = p[1] - (a[1] + t * dy);
  return ex * ex + ey * ey;
}
