// Stage 5: junction synthesis (doc02.07). GTFS ships one independent polyline per route+direction
// and carries NO junction topology — where a branch meets a trunk we get a cluster of dangling
// polyline ends near a common point, short of and at an angle to the trunk, never a shared node.
//
// This stage builds the topology the data omits, then closes each gap by extending the branch — not
// by reshaping it:
//   A. Node inference — cluster corridor endpoints of different route-sets within a tolerance; each
//      cluster of ≥2 route-sets is one junction, its trunk the busiest incident corridor.
//   B. Arc extrapolation — for each branch end that points at the trunk, fit a circle to the branch's
//      last few vertices (the arc it is already on) and march forward along it, keeping that
//      curvature, until the path reaches the trunk centerline; snap the final point onto the trunk so
//      the centerlines touch. The branch's real geometry is preserved in full — we only GROW the
//      missing connector, never trim or force a foreign tangent (which produced a wandering S). A
//      near-straight branch extends as a ray; if the arc never approaches the trunk, a straight
//      segment closes the gap. A true terminus (trunk not ahead of the end) is left untouched.
//
// Runs on collapsed corridors (drawing-only, downstream of the motion index), so authored junction
// curves never perturb train motion.

import { projectNyc, unprojectNyc } from "./geo";
import type { Corridor } from "./pipeline-types";

type Pt = [number, number];

// Endpoints of different route-sets within this join one junction node.
const CLUSTER_R_M = 35;
// Circle fit: vertices nearest the branch end that define the arc being continued.
const FIT_POINTS = 6;
// March step and the cap on how far a gap may be closed (a runaway arc gives up before this).
const STEP_M = 2;
const MIN_MAX_EXT_M = 50;
// The march has reached the trunk once within this of its centerline.
const CONTACT_EPS_M = 1.5;
// If the arc's closest approach to the trunk still exceeds this, it is diverging — fall back to a
// straight connector rather than snapping across a wide gap.
const MAX_CONTACT_M = 18;
// Beyond this radius the fit is effectively a straight line; extend as a ray to avoid huge-circle
// numerical noise.
const MAX_FIT_R_M = 4000;

interface EndRef {
  ci: number; // corridor index
  end: 0 | 1; // 0 = start vertex, 1 = last vertex
  p: Pt; // endpoint position (meters)
  out: Pt; // outward unit tangent (inner neighbour → endpoint), points into the junction
  key: string; // sorted route key
  nroutes: number;
  len: number; // corridor length (meters), trunk tiebreak
}

export function buildJunctions(corridors: Corridor[]): Corridor[] {
  const lines = corridors.map((c) => c.centerline.map(projectNyc));
  const keys = corridors.map((c) => [...c.routes].sort().join(","));

  const ends: EndRef[] = [];
  corridors.forEach((c, ci) => {
    const m = lines[ci];
    if (m.length < 2) return;
    const len = pathLength(m);
    const n = m.length;
    ends.push({
      ci,
      end: 0,
      p: m[0],
      out: unit(sub(m[0], m[1])),
      key: keys[ci],
      nroutes: c.routes.length,
      len,
    });
    ends.push({
      ci,
      end: 1,
      p: m[n - 1],
      out: unit(sub(m[n - 1], m[n - 2])),
      key: keys[ci],
      nroutes: c.routes.length,
      len,
    });
  });

  // A. Cluster endpoints of different route-sets within CLUSTER_R (union-find).
  const parent = ends.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (parent[cur] !== r) {
      const nx = parent[cur];
      parent[cur] = r;
      cur = nx;
    }
    return r;
  };
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].key === ends[j].key) continue;
      if (dist(ends[i].p, ends[j].p) <= CLUSTER_R_M) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < ends.length; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  // Extension per branch end, ordered endpoint → contact (excluding the endpoint itself).
  const heads = new Map<number, Pt[]>();
  const tails = new Map<number, Pt[]>();

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    if (new Set(idxs.map((i) => ends[i].key)).size < 2) continue;

    // Trunk = busiest incident corridor (most routes, then longest). Branches extend onto its line.
    let trunk = idxs[0];
    for (const i of idxs) {
      const a = ends[i];
      const b = ends[trunk];
      if (a.nroutes > b.nroutes || (a.nroutes === b.nroutes && a.len > b.len))
        trunk = i;
    }
    const trunkLine = lines[ends[trunk].ci];

    // B. Extend every other incident end that points at the trunk. Each end handled once.
    for (const i of idxs) {
      if (ends[i].ci === ends[trunk].ci) continue;
      const e = ends[i];
      if (e.end === 0 ? heads.has(e.ci) : tails.has(e.ci)) continue;
      const ext = extendToTrunk(lines[e.ci], e.end, e.out, trunkLine);
      if (ext.length === 0) continue;
      if (e.end === 0) heads.set(e.ci, ext);
      else tails.set(e.ci, ext);
    }
  }

  // Reassemble: keep every original vertex, prepend/append the grown connector.
  return corridors.map((c, ci) => {
    const head = heads.get(ci);
    const tail = tails.get(ci);
    if (!head && !tail) return c;
    const m = lines[ci];
    const pre = head ? [...head].reverse() : []; // contact → … → just before start
    const post = tail ?? []; // just after end → … → contact
    const rebuilt = [...pre, ...m, ...post].map(unprojectNyc);
    return { ...c, centerline: rebuilt };
  });
}

// Grow the dangling `end` of branch `m` until it meets `trunk`, keeping the branch's own curvature.
// Returns the added points ordered endpoint → contact (excluding the endpoint), empty if the trunk
// is behind the end (a terminus) so nothing should be grown.
function extendToTrunk(m: Pt[], end: 0 | 1, out: Pt, trunk: Pt[]): Pt[] {
  const n = m.length;
  const E = end === 0 ? m[0] : m[n - 1];
  const near0 = nearestOnPolyline(E, trunk);
  if (dot(sub(near0.pt, E), out) <= 0) return []; // trunk not ahead → real terminus
  const maxLen = Math.max(MIN_MAX_EXT_M, near0.d * 2.5);

  const fit: Pt[] = [];
  for (let k = 0; k < Math.min(FIT_POINTS, n); k++)
    fit.push(end === 0 ? m[k] : m[n - 1 - k]);
  const circ = fitCircle(fit);

  // Candidate march points, one every STEP_M, continuing the branch's arc (or a ray if ~straight).
  const cand: Pt[] = [];
  if (circ && circ.r < MAX_FIT_R_M) {
    const cToE = sub(E, circ.c);
    const dir = dot([-cToE[1], cToE[0]], out) > 0 ? 1 : -1; // sweep that heads outward
    const dTheta = (dir * STEP_M) / circ.r;
    let theta = Math.atan2(cToE[1], cToE[0]);
    for (let t = STEP_M; t < maxLen; t += STEP_M) {
      theta += dTheta;
      cand.push([
        circ.c[0] + circ.r * Math.cos(theta),
        circ.c[1] + circ.r * Math.sin(theta),
      ]);
    }
  } else {
    for (let t = STEP_M; t < maxLen; t += STEP_M)
      cand.push([E[0] + out[0] * t, E[1] + out[1] * t]);
  }

  // Truncate at the closest approach to the trunk and snap that point exactly onto it.
  let bestI = -1;
  let bestD = Number.POSITIVE_INFINITY;
  let bestPt: Pt = near0.pt;
  for (let i = 0; i < cand.length; i++) {
    const nr = nearestOnPolyline(cand[i], trunk);
    if (nr.d < bestD) {
      bestD = nr.d;
      bestI = i;
      bestPt = nr.pt;
    }
    if (nr.d <= CONTACT_EPS_M) break;
  }
  if (bestI < 0 || bestD > MAX_CONTACT_M) return [near0.pt]; // diverged → straight connector
  return [...cand.slice(0, bestI), bestPt];
}

// Least-squares (Kåsa) circle through the points; null if they are collinear (→ straight fit).
function fitCircle(pts: Pt[]): { c: Pt; r: number } | null {
  if (pts.length < 3) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const sol = solve3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, pts.length],
    ],
    [sxz, syz, sz],
  );
  if (!sol) return null;
  const [d, e, f] = sol;
  const c: Pt = [d / 2, e / 2];
  const r2 = f + c[0] * c[0] + c[1] * c[1];
  if (r2 <= 0) return null;
  return { c, r: Math.sqrt(r2) };
}

function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const det = det3(a);
  if (Math.abs(det) < 1e-9) return null;
  const col = (k: number) =>
    a.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  return [det3(col(0)) / det, det3(col(1)) / det, det3(col(2)) / det];
}
function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function nearestOnPolyline(p: Pt, line: Pt[]): { pt: Pt; d: number } {
  let best: Pt = line[0];
  let bd = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length - 1; i++) {
    const q = projectPointSeg(p, line[i], line[i + 1]);
    const d = dist(p, q);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return { pt: best, d: bd };
}

function projectPointSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.min(1, Math.max(0, t));
  return [a[0] + t * dx, a[1] + t * dy];
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
function pathLength(m: Pt[]): number {
  let s = 0;
  for (let i = 1; i < m.length; i++) s += dist(m[i - 1], m[i]);
  return s;
}

// Corridor centerlines as debug polylines (one per corridor, colored by its first route) for the
// web debug graph — drawn as skinny 3D pipes to compare pipeline stages.
export function corridorsToDebugLines(corridors: Corridor[]) {
  return corridors.map((c) => ({
    coordinates: c.centerline,
    color: c.palette[0] ?? "#888888",
  }));
}

// Debug artifact: corridor centerlines as inspectable LineStrings, so `just inspect` can read them
// in the segment schema at any pipeline stage (e.g. before vs after junction synthesis).
export function corridorsToFeatureCollection(corridors: Corridor[]) {
  return {
    type: "FeatureCollection" as const,
    features: corridors.map((c) => ({
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: c.centerline },
      properties: {
        id: c.id,
        routes: c.routes,
        colors: c.palette,
        colorCount: c.palette.length,
        color0: c.palette[0] ?? "#888888",
      },
    })),
  };
}
