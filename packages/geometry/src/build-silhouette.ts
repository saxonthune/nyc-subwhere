// Junction tessellation (doc02.07): turn the network of centerlines into one seamless
// filled surface by buffering each Segment centerline to a ribbon and boolean-unioning
// (dissolving) the overlaps. Merges and branches then fall out for free — a merge is
// just two ribbons whose union overlaps — so no branch conforming, merge-lift, or gore
// patching is needed. The union's boundary rings are the outline the renderer extrudes
// into platform edges.
//
// Phase 1 is flat: every Segment unions at one grade. Grade-separated crossings (union
// per grade band, drawn at different heights) are a later pass — until then a crossing
// dissolves into the surface like a merge.
//
// Clipper (integer coordinates) rather than a float boolean library: the float clippers
// go non-robust on a dense overlapping network ("unable to complete output ring"),
// whereas Clipper is exact on its integer grid. Its ClipperOffset also buffers an open
// polyline with round joins/caps directly, so no Minkowski disc decomposition is needed.

import type { LngLat, SegmentCollection } from "@nyc-subwhere/contract";
import ClipperLib from "clipper-lib";
import type { IntPoint, PolyNode } from "clipper-lib";
import { projectNyc, unprojectNyc } from "./geo";

// Half-ribbon width in meters. MUST match the renderer's NETWORK_STYLE.track.halfWidth
// so the baked silhouette lines up with the per-corridor caret floors drawn on top.
const HALF_WIDTH_M = 26;
// Coordinates are scaled to integers at this resolution (units per metre) for Clipper.
// 100 => centimetre grid: finer than any visible detail, coarse enough to fuse
// coincident track without slivers.
const SCALE = 100;
// Max deviation (metres) of a round join's polyline approximation from the true arc.
const ARC_TOLERANCE_M = 0.3;

// Shift to a fixed NYC-local origin before scaling so integer magnitudes stay small
// (~10⁶ not 10⁸); deterministic across builds.
const ORIGIN = projectNyc([-74.0, 40.72]);
const toInt = (p: LngLat): IntPoint => {
  const [x, y] = projectNyc(p);
  return {
    X: Math.round((x - ORIGIN[0]) * SCALE),
    Y: Math.round((y - ORIGIN[1]) * SCALE),
  };
};
const fromInt = (p: IntPoint): LngLat =>
  unprojectNyc([p.X / SCALE + ORIGIN[0], p.Y / SCALE + ORIGIN[1]]);

// The whole network's dissolved outline: buffer every Segment into a ribbon, union the
// ribbons, and return each polygon as [outerRing, ...holeRings] in LngLat. The renderer
// extrudes each ring into a platform edge.
export function buildSilhouette(segments: SegmentCollection): LngLat[][][] {
  const ribbons: IntPoint[][] = [];
  for (const f of segments.features) {
    const path = f.geometry.coordinates.map(toInt);
    if (path.length < 2) continue;
    const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE_M * SCALE);
    co.AddPath(
      path,
      ClipperLib.JoinType.jtRound,
      ClipperLib.EndType.etOpenRound,
    );
    const solution: IntPoint[][] = [];
    co.Execute(solution, HALF_WIDTH_M * SCALE);
    ribbons.push(...solution);
  }
  if (ribbons.length === 0) return [];

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(ribbons, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );

  const polygons: LngLat[][][] = [];
  const ringOf = (n: PolyNode): LngLat[] => n.Contour().map(fromInt);
  // PolyTree nests outer→hole→outer…: a top node is a filled contour, its child nodes are
  // its holes, and each hole's children are fresh filled contours (islands in the hole).
  const collect = (outer: PolyNode): void => {
    const holes = outer.Childs();
    polygons.push([ringOf(outer), ...holes.map(ringOf)]);
    for (const h of holes) for (const inner of h.Childs()) collect(inner);
  };
  for (const top of tree.Childs()) collect(top);
  return polygons;
}
