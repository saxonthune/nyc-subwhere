// Stage 4: grade assignment (doc02.07). Finds where two corridors overlap — a true crossing, a
// sustained near-parallel run, or an endpoint merging into a trunk — decides which passes over
// (busier route-set on top), and assigns each corridor a *constant* grade level: one above every
// corridor it is over, via a longest-path level over the overlap graph. The renderer draws higher
// levels in front (polygonOffset), so overlapping floors resolve in the depth buffer with no
// z-fighting and no geometric bump — and a branch tucks under its trunk at a merge by depth (C1),
// so no taper geometry is needed.
//
// Operates on collapsed corridors (one per physical track); a corridor's `id` is its owned
// segment index, so the reported crossings index segments.geojson for the junction inspector.

import type { LngLat, TrackCrossing } from "@nyc-subwhere/contract";
import { projectNyc } from "./geo";
import type { Corridor, GradedCorridor } from "./pipeline-types";

// An intersection within this of either corridor's endpoint is a merge/branch throat, handled by
// the endpoint-merge pass below rather than counted as a crossing.
const ENDPOINT_EXCLUDE_M = 12;
// A crossing shallower than this is treated as a near-parallel artifact and skipped.
const CROSS_MIN_ANGLE_DEG = 8;
// Overlap leveling: two corridors whose centerlines run within this of each other (their
// half-width 26 m ribbons overlap) for at least OVERLAP_MIN_M of length, but never actually
// cross, still get a grade step so their floors don't z-fight along the shared run. Meters.
const OVERLAP_DIST_M = 36;
const OVERLAP_MIN_M = 40;
// Endpoint merge (C1): a corridor endpoint landing within this of a different-route corridor's
// centerline is a branch merging into a trunk. The trunk grades over the branch so the branch
// tucks under by draw order — the taper replacement. Half the ribbon width, so only a genuine
// throat (endpoint inside the trunk footprint) counts, not a distant parallel line.
const MERGE_NEAR_M = 13;
// Cap the grade stack; beyond it rare same-level overlaps just z-resolve arbitrarily.
const MAX_LEVEL = 4;

type Pt = [number, number]; // meters

interface Seg {
  id: number; // corridor id (= owned segment index)
  ll: LngLat[];
  m: Pt[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  routes: string[];
  len: number; // projected centerline length (trunk-vs-branch tiebreak)
}

export function assignGrade(corridors: Corridor[]): {
  graded: GradedCorridor[];
  crossings: TrackCrossing[];
} {
  const segs: Seg[] = corridors.map((c) => {
    const ll = c.centerline;
    const m = ll.map(projectNyc);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let len = 0;
    for (const [x, y] of m) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    for (let i = 1; i < m.length; i++) len += dist(m[i - 1], m[i]);
    return { id: c.id, ll, m, minX, minY, maxX, maxY, routes: c.routes, len };
  });

  // Grade relations (over must sit above under): a true crossing, a sustained near-parallel
  // overlap, or an endpoint merge. Both feed the level DAG so any overlapping pair separates in
  // depth. Relations index into `segs` (dense corridor order), not corridor ids.
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
        crossings.push({
          point: hit,
          over: overId(sa, sb),
          under: underId(sa, sb),
        });
        relations.push(overUnder(a, b, sa, sb));
        continue;
      }
      // A detected merge forces a winner even between same-route corridors (a branch of one route
      // joining its own trunk), so the throat always has a clean occluder and never coplanar-fights.
      // The overlap-leveling relation stays different-route only (parallel same-route runs like a
      // local beside its own express are left to z-resolve, not forcibly stacked).
      if (endpointMerges(sa, sb)) {
        relations.push(overUnder(a, b, sa, sb));
        continue;
      }
      if (sameRoutes(sa, sb)) continue;
      if (overlapLength(sa, sb, OVERLAP_DIST_M) >= OVERLAP_MIN_M) {
        relations.push(overUnder(a, b, sa, sb));
      }
    }
  }

  // Longest-path grade level: over must sit above under, so level[over] ≥ level[under] + 1.
  // Relax to a fixed point (priority is total, so the over→under graph is acyclic).
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

  const graded = corridors.map((c, i) => ({
    ...c,
    grade: Math.min(level[i], MAX_LEVEL),
  }));
  return { graded, crossings };
}

// Whether either corridor has an endpoint within MERGE_NEAR_M of the other's centerline — a
// branch merging into a trunk. Different-route already ensured by the caller.
function endpointMerges(sa: Seg, sb: Seg): boolean {
  const near = (e: Pt, poly: Pt[]) =>
    Math.sqrt(pointPolyD2(e, poly)) <= MERGE_NEAR_M;
  return (
    near(sa.m[0], sb.m) ||
    near(sa.m[sa.m.length - 1], sb.m) ||
    near(sb.m[0], sa.m) ||
    near(sb.m[sb.m.length - 1], sa.m)
  );
}

// The first transversal interior intersection of two corridors: away from every endpoint (else
// it is a merge) and steeper than the min angle (else near-parallel).
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

// Busier corridor (more routes, then longer route list, then lexicographic) goes on top. A
// stable rule, not a semantic claim about real elevation. `overUnder` returns the pair as
// [over, under] in dense `segs` order (for the level DAG); `overId`/`underId` as corridor ids
// (for the reported crossing).
function overIsA(sa: Seg, sb: Seg): boolean {
  const ka = sa.routes.length;
  const kb = sb.routes.length;
  if (ka !== kb) return ka > kb;
  // Same route count (incl. a same-route branch/trunk): the longer corridor is the through trunk,
  // so it sits on top and the shorter branch tucks under it.
  if (Math.abs(sa.len - sb.len) > 1) return sa.len > sb.len;
  return sa.routes.join(",") <= sb.routes.join(",");
}
function overUnder(a: number, b: number, sa: Seg, sb: Seg): [number, number] {
  return overIsA(sa, sb) ? [a, b] : [b, a];
}
function overId(sa: Seg, sb: Seg): number {
  return overIsA(sa, sb) ? sa.id : sb.id;
}
function underId(sa: Seg, sb: Seg): number {
  return overIsA(sa, sb) ? sb.id : sa.id;
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

// Arc-length of sa that runs within maxDist of sb's polyline — how far the two ribbons overlap
// side by side. Approximated by summing sa's edges whose midpoint is within range.
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
