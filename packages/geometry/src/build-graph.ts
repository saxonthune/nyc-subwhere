// Stage 4: junction graph (doc02.05). Reads the final segments (edges) and emits
// the topology the renderer needs to stitch them where they meet or cross —
// endpoint clusters that branch (junctions) and mid-segment crossings of
// unconnected edges (with a baked over/under priority). Facts only: this computes
// what is true about the network; the renderer decides how to draw each node
// (doc01.03).

import type {
  EdgeEnd,
  LngLat,
  SegmentCollection,
  TrackGraph,
  TrackNode,
} from "@nyc-subwhere/contract";
import { projectNyc } from "./geo";

// Endpoints within this fuse into one node; a crossing must land at least this far
// from either segment's endpoints, else the two edges are connected there (a
// junction) rather than crossing.
const CLUSTER_EPS_M = 14;
// Two outgoing edge directions count as distinct only past this angle, so a
// straight-through station (two near-opposite directions, doubled by the N/S
// features) reads as a continuation, not a junction.
const DIR_EPS_DEG = 20;
// A crossing shallower than this is a merge/parallel artifact, not a clean cross;
// skip it so it gets no grade-separation lift.
const CROSS_MIN_ANGLE_DEG = 20;

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
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of m) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { i, ll, m, minX, minY, maxX, maxY, routes: f.properties.routes };
  });

  const nodes: TrackNode[] = [
    ...junctionNodes(segs),
    ...crossingNodes(segs),
  ];
  return { nodes };
}

// Cluster segment endpoints; a cluster whose members leave in three or more
// distinct directions is a branch point. The outgoing direction of an end is the
// bearing from the endpoint toward its neighbor vertex.
function junctionNodes(segs: Seg[]): TrackNode[] {
  interface End {
    seg: number;
    end: "start" | "end";
    p: Pt;
    ll: LngLat;
    dir: number; // radians, pointing away from the endpoint into the segment
  }
  const ends: End[] = [];
  for (const s of segs) {
    if (s.m.length < 2) continue;
    ends.push({
      seg: s.i,
      end: "start",
      p: s.m[0],
      ll: s.ll[0],
      dir: Math.atan2(s.m[1][1] - s.m[0][1], s.m[1][0] - s.m[0][0]),
    });
    const n = s.m.length - 1;
    ends.push({
      seg: s.i,
      end: "end",
      p: s.m[n],
      ll: s.ll[n],
      dir: Math.atan2(s.m[n - 1][1] - s.m[n][1], s.m[n - 1][0] - s.m[n][0]),
    });
  }

  const clusters: End[][] = [];
  for (const e of ends) {
    const c = clusters.find((cl) => dist(centroid(cl.map((x) => x.p)), e.p) <= CLUSTER_EPS_M);
    if (c) c.push(e);
    else clusters.push([e]);
  }

  const out: TrackNode[] = [];
  for (const cl of clusters) {
    if (cl.length < 3) continue;
    if (distinctDirections(cl.map((e) => e.dir)) < 3) continue;
    const cll = centroidLL(cl.map((e) => e.ll));
    const ends2: EdgeEnd[] = cl.map((e) => ({ seg: e.seg, end: e.end }));
    out.push({ kind: "junction", point: cll, ends: ends2 });
  }
  return out;
}

// Pairwise mid-segment crossings of unconnected edges. One crossing per segment
// pair (the first clean intersection found); the busier edge is drawn on top.
function crossingNodes(segs: Seg[]): TrackNode[] {
  const out: TrackNode[] = [];
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
      out.push({ kind: "crossing", point: hit, over, under });
    }
  }
  return out;
}

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
      // Connected there (a shared station), not a crossing.
      if (
        near(p, sa.m[0]) ||
        near(p, sa.m[sa.m.length - 1]) ||
        near(p, sb.m[0]) ||
        near(p, sb.m[sb.m.length - 1])
      )
        continue;
      if (angleBetween(a1, a2, b1, b2) < (CROSS_MIN_ANGLE_DEG * Math.PI) / 180)
        continue;
      // Lerp the lon/lat by the same parameter as the meter-space hit.
      const p0 = sa.ll[i];
      const p1 = sa.ll[i + 1];
      return [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
    }
  }
  return null;
}

// Busier edge (more routes, then more of a longer route list, then lexicographic)
// goes on top. A stable rule, not a semantic claim — swap it here to change policy.
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

function distinctDirections(dirs: number[]): number {
  const eps = (DIR_EPS_DEG * Math.PI) / 180;
  const reps: number[] = [];
  for (const d of dirs) {
    if (!reps.some((r) => angularDist(r, d) <= eps)) reps.push(d);
  }
  return reps.length;
}

function angularDist(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

function near(a: Pt, b: Pt): boolean {
  return dist(a, b) <= CLUSTER_EPS_M;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function centroid(ps: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ps) {
    x += p[0];
    y += p[1];
  }
  return [x / ps.length, y / ps.length];
}

function centroidLL(ps: LngLat[]): LngLat {
  let x = 0;
  let y = 0;
  for (const p of ps) {
    x += p[0];
    y += p[1];
  }
  return [x / ps.length, y / ps.length];
}
