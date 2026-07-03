// Junction tessellation (doc02.07): turn the network of centerlines into one seamless
// filled surface by buffering each Segment centerline to a ribbon and boolean-unioning
// (dissolving) the overlaps. Merges and branches then fall out for free — a merge is
// just two ribbons whose union overlaps — so no branch conforming, merge-lift, or gore
// patching is needed. The union's boundary rings are the outline the renderer extrudes
// into platform edges.
//
// Grade separation (doc02.07) is handled by a constant per-corridor height (build-graph),
// not by cutting the outline: a crossing's over track sits a small step above the under
// track, so their floors resolve by depth with no bump. The silhouette therefore unions
// the whole flat network — one continuous platform outline — and the raised floors simply
// hover a few centimetres above it.
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
// Turnout taper length (metres). MUST match NETWORK_STYLE.track.taperLenM: a merging end's
// ribbon narrows to a point over this arc length so the silhouette outline hugs the tapered
// caret floor rather than bulging into the gore beside it.
const TAPER_LEN_M = 34;
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
const meterToInt = (x: number, y: number): IntPoint => ({
  X: Math.round((x - ORIGIN[0]) * SCALE),
  Y: Math.round((y - ORIGIN[1]) * SCALE),
});

// The network's dissolved outline: buffer every Segment into a ribbon, union them, and
// return each polygon as [outerRing, ...holeRings] in LngLat. The renderer extrudes each
// ring into a platform edge.
export function buildSilhouette(
  segments: SegmentCollection,
  taper: [boolean, boolean][],
): LngLat[][][] {
  const ribbons: IntPoint[][] = [];
  segments.features.forEach((f, i) => {
    const coords = f.geometry.coordinates;
    if (coords.length < 2) return;
    const [tStart, tEnd] = taper[i] ?? [false, false];
    if (tStart || tEnd) {
      // A merging end narrows to a point, so its ribbon is a manual variable-width polygon
      // (ClipperOffset only buffers at a constant delta). The union dissolves it like any
      // other subject path.
      ribbons.push(taperedRibbon(coords.map(projectNyc), tStart, tEnd));
      return;
    }
    const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE_M * SCALE);
    co.AddPath(
      coords.map(toInt),
      ClipperLib.JoinType.jtRound,
      ClipperLib.EndType.etOpenRound,
    );
    const solution: IntPoint[][] = [];
    co.Execute(solution, HALF_WIDTH_M * SCALE);
    ribbons.push(...solution);
  });
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

// Taper width fraction (0..1) at each vertex — the ribbon narrows toward a merging end. Two
// guards keep short trunk-connectors (both ends flagged) from collapsing to a spindle: each
// end's ramp is capped to a fraction of the total so a full-width core survives, and the tip
// keeps a small width so its cap is swallowed by the trunk rather than left as a spike. MUST
// match the renderer's taperProfile (track-render) so the outline hugs the caret floor.
const TAPER_TIP_FRAC = 0.12;
const TAPER_MAX_FRAC_BOTH = 0.4;
const TAPER_MAX_FRAC_ONE = 0.85;
function taperProfile(cum: number[], tStart: boolean, tEnd: boolean): number[] {
  const total = cum[cum.length - 1] || 1;
  const cap = tStart && tEnd ? TAPER_MAX_FRAC_BOTH : TAPER_MAX_FRAC_ONE;
  const lStart = tStart ? Math.min(TAPER_LEN_M, cap * total) : 0;
  const lEnd = tEnd ? Math.min(TAPER_LEN_M, cap * total) : 0;
  const ramp = (d: number, l: number) => (l <= 0 ? 1 : Math.min(1, d / l));
  return cum.map((c) => {
    const f = Math.min(ramp(c, lStart), ramp(total - c, lEnd));
    return TAPER_TIP_FRAC + (1 - TAPER_TIP_FRAC) * f;
  });
}

// A closed ribbon polygon whose half-width tapers toward each merging end (tStart / tEnd),
// following taperProfile so the outline hugs the renderer's caret taper. A non-merging end
// keeps full width and a flat (butt) cap; the neighbouring segment's round-capped ribbon
// overshoots it in the union, so no seam opens.
function taperedRibbon(
  m: [number, number][],
  tStart: boolean,
  tEnd: boolean,
): IntPoint[] {
  const n = m.length;
  const cum = [0];
  for (let i = 1; i < n; i++)
    cum.push(
      cum[i - 1] + Math.hypot(m[i][0] - m[i - 1][0], m[i][1] - m[i - 1][1]),
    );
  const frac = taperProfile(cum, tStart, tEnd);
  const width = (i: number) => HALF_WIDTH_M * frac[i];
  // Right-hand unit normal of the central-difference tangent at vertex i.
  const normal = (i: number): [number, number] => {
    const a = m[Math.max(0, i - 1)];
    const b = m[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    return [ty / len, -tx / len];
  };
  const left: IntPoint[] = [];
  const right: IntPoint[] = [];
  for (let i = 0; i < n; i++) {
    const [nx, ny] = normal(i);
    const w = width(i);
    left.push(meterToInt(m[i][0] + nx * w, m[i][1] + ny * w));
    right.push(meterToInt(m[i][0] - nx * w, m[i][1] - ny * w));
  }
  return [...left, ...right.reverse()];
}
