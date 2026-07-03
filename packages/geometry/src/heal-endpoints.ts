// Stage 3c: endpoint healing (doc02.07). A branch that merges into a trunk carries a
// different route set, so build-segments cuts it at a different station than the trunk and
// its terminal vertex lands a few metres short of the trunk centerline. The buffer→union
// silhouette (build-silhouette) and the per-corridor caret floor (track-render) then both
// stop there, so the throat shows a notch and the colour ends before the platform edge.
// This pass extends each dangling endpoint onto the trunk it points at, so the two ribbons
// fully overlap and the throat dissolves in the union with no special-casing downstream.
//
// It also reports, per segment, which ends are such angled merges (`taper`), so the renderer
// can taper that end's caret floor to a point — the branch then tucks under the trunk like a
// turnout instead of piling on full-width and clashing (doc02.07).

import type { SegmentCollection } from "@nyc-subwhere/contract";
import { projectNyc, unprojectNyc } from "./geo";

type Pt = [number, number];

// Nearer than HEAL_MIN the endpoint already meets the trunk (no extension, but still a merge
// to taper); past HEAL_MAX the two ends belong to unrelated tracks, not one throat.
// HEAL_FWD_COS keeps a merge to where the end already points (a branch curving into its
// trunk), so a merely-adjacent parallel line is ignored.
const HEAL_MIN_M = 3;
const HEAL_MAX_M = 32;
const HEAL_FWD_COS = Math.cos((75 * Math.PI) / 180);

export interface HealResult {
  segments: SegmentCollection;
  // Parallel to segments.features: whether [start, end] is an angled merge into a trunk.
  taper: [boolean, boolean][];
}

export function healEndpoints(segments: SegmentCollection): HealResult {
  const lines = segments.features.map((f) =>
    f.geometry.coordinates.map(projectNyc),
  );
  const key = segments.features.map((f) =>
    [...f.properties.routes].sort().join(","),
  );
  const bbox = lines.map(boundsOf);

  const taper: [boolean, boolean][] = [];
  const features = segments.features.map((f, i) => {
    const line = lines[i];
    if (line.length < 2) {
      taper.push([false, false]);
      return f;
    }
    const n = line.length;
    const head = mergeAt(line[0], line[1], i, lines, key, bbox);
    const tail = mergeAt(line[n - 1], line[n - 2], i, lines, key, bbox);
    taper.push([head !== null, tail !== null]);
    if (!head?.extend && !tail?.extend) return f;
    const coords = [...f.geometry.coordinates];
    if (head?.extend) coords.unshift(unprojectNyc(head.extend));
    if (tail?.extend) coords.push(unprojectNyc(tail.extend));
    return { ...f, geometry: { ...f.geometry, coordinates: coords } };
  });
  return { segments: { ...segments, features }, taper };
}

interface Merge {
  // Where to extend the endpoint to (along its own tangent toward the trunk), or null when
  // the endpoint already meets the trunk within HEAL_MIN and only needs the taper flag.
  extend: Pt | null;
}

// If endpoint `e` is an angled merge into a different-route segment — within HEAL_MAX and
// ahead of the outward tangent (e minus its inner neighbour) — return the merge (with an
// extension target when the gap exceeds HEAL_MIN). Otherwise null. Evaluated against the
// original geometry, so order does not matter.
function mergeAt(
  e: Pt,
  inner: Pt,
  self: number,
  lines: Pt[][],
  key: string[],
  bbox: Bounds[],
): Merge | null {
  const tx = e[0] - inner[0];
  const ty = e[1] - inner[1];
  const tl = Math.hypot(tx, ty) || 1;
  let best: { d: number; q: Pt } | null = null;
  for (let j = 0; j < lines.length; j++) {
    if (j === self || key[j] === key[self]) continue;
    const b = bbox[j];
    if (
      e[0] < b.minX - HEAL_MAX_M ||
      e[0] > b.maxX + HEAL_MAX_M ||
      e[1] < b.minY - HEAL_MAX_M ||
      e[1] > b.maxY + HEAL_MAX_M
    )
      continue;
    const o = lines[j];
    for (let k = 0; k < o.length - 1; k++) {
      const q = projectPointSeg(e, o[k], o[k + 1]);
      const d = Math.hypot(e[0] - q[0], e[1] - q[1]);
      if (!best || d < best.d) best = { d, q };
    }
  }
  if (!best || best.d > HEAL_MAX_M) return null;
  const ux = tx / tl;
  const uy = ty / tl;
  const dot =
    ((best.q[0] - e[0]) * ux + (best.q[1] - e[1]) * uy) / (best.d || 1);
  if (dot < HEAL_FWD_COS) return null;
  // Extend along the endpoint's own tangent (project the trunk point onto the tangent ray),
  // not straight to the nearest point. A straight jump to the nearest point turns ~60° off the
  // branch's heading — a curvature reversal that renders as a non-convex kink (doc02.07). Staying
  // on the tangent keeps the join C1 (no cusp); the trunk ribbon's half-width still swallows the
  // tip, so the union closes.
  const fwd = (best.q[0] - e[0]) * ux + (best.q[1] - e[1]) * uy;
  return {
    extend: fwd > HEAL_MIN_M ? [e[0] + ux * fwd, e[1] + uy * fwd] : null,
  };
}

function projectPointSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.min(1, Math.max(0, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
function boundsOf(line: Pt[]): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of line) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
