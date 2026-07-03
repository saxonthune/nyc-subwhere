// Stage 6b: outline (doc02.07). Close each ribbon's left/right edges into a round-capped ring
// and boolean-union (dissolve) them all into the network outline. Merges and branches fall out
// for free — a merge is two rings whose union overlaps, closed by the healed endpoints — so no
// per-junction patching is needed. The union's boundary rings are the outline the renderer
// extrudes into platform edges.
//
// The rings are the SAME left/right vertices build-fill triangulates, so fill and outline share
// one boundary. Only the caps are added here (round, so adjacent corridors overlap and dissolve
// at stations). Clipper (integer coordinates) rather than a float boolean library: the float
// clippers go non-robust on a dense overlapping network, whereas Clipper is exact on its grid.

import type { LngLat } from "@nyc-subwhere/contract";
import ClipperLib from "clipper-lib";
import type { IntPoint, PolyNode } from "clipper-lib";
import { projectNyc, unprojectNyc } from "./geo";
import type { RibbonPolygon } from "./pipeline-types";

// Integer grid resolution (units per metre) for Clipper. 100 => centimetre grid: finer than any
// visible detail, coarse enough to fuse coincident track without slivers.
const SCALE = 100;
// Points per 180° round end cap. Enough to read as round at the ribbon width; the union only
// needs the covered area, not a smooth arc.
const CAP_STEPS = 8;

// Fixed NYC-local origin so integer magnitudes stay small (~10⁶) and deterministic.
const ORIGIN = projectNyc([-74.0, 40.72]);
type Pt = [number, number];
const toInt = (m: Pt): IntPoint => ({
  X: Math.round((m[0] - ORIGIN[0]) * SCALE),
  Y: Math.round((m[1] - ORIGIN[1]) * SCALE),
});
const fromInt = (p: IntPoint): LngLat =>
  unprojectNyc([p.X / SCALE + ORIGIN[0], p.Y / SCALE + ORIGIN[1]]);

// The network's dissolved outline: close each ribbon into a capped ring, union them, and return
// each polygon as [outerRing, ...holeRings] in LngLat. The renderer extrudes each ring.
export function buildOutline(ribbons: RibbonPolygon[]): LngLat[][][] {
  const paths: IntPoint[][] = [];
  for (const r of ribbons) {
    const n = r.left.length;
    if (n < 2) continue;
    const leftM = r.left.map((v) => projectNyc(v.lngLat));
    const rightM = r.right.map((v) => projectNyc(v.lngLat));
    const center = (i: number): Pt => [
      (leftM[i][0] + rightM[i][0]) / 2,
      (leftM[i][1] + rightM[i][1]) / 2,
    ];

    const ring: Pt[] = [];
    for (let i = 0; i < n; i++) ring.push(leftM[i]);
    ring.push(
      ...capArc(center(n - 1), leftM[n - 1], out(center(n - 1), center(n - 2))),
    );
    for (let i = n - 1; i >= 0; i--) ring.push(rightM[i]);
    ring.push(...capArc(center(0), rightM[0], out(center(0), center(1))));
    paths.push(ring.map(toInt));
  }
  if (paths.length === 0) return [];

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );

  const polygons: LngLat[][][] = [];
  const ringOf = (node: PolyNode): LngLat[] => node.Contour().map(fromInt);
  // PolyTree nests outer→hole→outer…: a top node is a filled contour, its children its holes,
  // and each hole's children fresh filled contours (islands in the hole).
  const collect = (outer: PolyNode): void => {
    const holes = outer.Childs();
    polygons.push([ringOf(outer), ...holes.map(ringOf)]);
    for (const h of holes) for (const inner of h.Childs()) collect(inner);
  };
  for (const top of tree.Childs()) collect(top);
  return polygons;
}

// Outward direction at an end: from the neighbouring center toward the end center.
function out(end: Pt, prev: Pt): Pt {
  const dx = end[0] - prev[0];
  const dy = end[1] - prev[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

// The semicircle bulging past a ribbon end, from `from` around to the diametrically-opposite
// edge point, choosing the half that bulges along `outward`. Returns the CAP_STEPS-1 interior
// points (the two edge endpoints are already in the ring).
function capArc(center: Pt, from: Pt, outward: Pt): Pt[] {
  const vx = from[0] - center[0];
  const vy = from[1] - center[1];
  const r = Math.hypot(vx, vy);
  const aFrom = Math.atan2(vy, vx);
  // Rotating `from` about center by +90° gives (-vy, vx); pick the sweep whose mid-arc points
  // along `outward`.
  const sweep = -vy * outward[0] + vx * outward[1] >= 0 ? Math.PI : -Math.PI;
  const pts: Pt[] = [];
  for (let k = 1; k < CAP_STEPS; k++) {
    const a = aFrom + sweep * (k / CAP_STEPS);
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  return pts;
}
