// Asset-pipeline stage boundaries (doc02.05 / doc02.07). One declared type per arrow in the
// geometry dataflow, gathered here so a stage's I/O contract is decoupled from how the stage
// computes it: changing a stage's internals never moves the type its neighbours depend on, and
// the whole flow is legible in one place when the pipeline is refactored.
//
// Split of ownership:
//   - Cross-package baked outputs (the web renderer consumes them) live in
//     @nyc-subwhere/contract. They are the pipeline's terminal boundary; see TrackGraph there.
//   - Geometry-internal stage boundaries live HERE. Some are presently still declared next to
//     their producing stage and re-exported below as the single index; migrate each definition
//     into this file as its stage is next touched.

import type { Direction, LngLat } from "@nyc-subwhere/contract";

// --- Upstream stages: GTFS rows → located canonical shapes ----------------------------------
// Definitions still live beside their producing stage; re-exported so this file indexes the
// full flow. (Move them here when those stages are next edited.)
export type { Normalized, Row, StopInfo } from "./gtfs-normalize";
export type { Canonical } from "./select-canonical";
export type { Located, LocatedStop } from "./locate-stops";
export type { MergeReport, SegmentPiece } from "./merge-corridors";

// --- Corridor: one physical track (the A+B collapse) ----------------------------------------
// GTFS ships a shape per direction, so build-segments emits two direction-keyed halves for one
// physical track. collapse-pairs matches the antiparallel pair and fuses them into ONE drawn
// centerline, so nothing downstream reconstructs a corridor from two lines (fuseFrames deleted).
// Direction survives only as a pointer back to the motion index / directional stops for
// picking — never as duplicate drawn geometry.
export interface SegRef {
  direction: Direction;
  // Index into the per-direction SegmentCollection this half came from (hit → directional stop).
  segmentIndex: number;
}
export interface Corridor {
  id: number;
  // Transformed in place by heal-endpoints then smooth-segments; always one polyline.
  centerline: LngLat[];
  routes: string[]; // all routeIds on this track (grade priority: busier on top)
  palette: string[]; // ≤4 route colors, for the caret shader
  halves: SegRef[]; // the 1–2 direction halves this corridor draws for
}

// --- GradedCorridor: + constant draw order --------------------------------------------------
// assign-grade tags each corridor with a grade level: the longest path over the DAG of true
// crossings, sustained near-parallel overlaps, and endpoint merges into a trunk (doc02.07).
// Grade is draw order via polygonOffset, not height, so nothing bumps; the merge edge (C1) is
// what lets a branch tuck under its trunk by depth, so no taper geometry is needed.
export interface GradedCorridor extends Corridor {
  grade: number;
}

// --- RibbonPolygon: THE single source of truth ----------------------------------------------
// build-ribbons offsets each graded centerline to constant-width left/right edges, each vertex
// tagged with the caret coordinates. Both derivations consume THESE SAME edges and nothing
// else — build-fill quad-strips them into the mesh, build-silhouette caps + unions them into
// the outline — so fill and outline share the exact boundary and cannot disagree.
export interface RibbonVertex {
  lngLat: LngLat;
  along: number; // arc length from the south end → caret shader aV
  across: number; // signed offset from centerline, ±HALF_WIDTH_M → caret shader aU
}
export interface RibbonPolygon {
  corridorId: number; // = the owned segment index (picking + palette)
  grade: number;
  // One vertex per centerline point. left = +normal side, right = -normal side; same `along`
  // at a shared index. build-silhouette closes them into a ring with round end caps.
  left: RibbonVertex[];
  right: RibbonVertex[];
}

// --- Terminal baked output ------------------------------------------------------------------
// The pipeline's cross-package boundary (web consumes it), so declared in @nyc-subwhere/
// contract and added to TrackGraph by the bake: `fill: TrackFill` (grade-grouped triangles +
// along/across/segId) alongside the kept `silhouette` (union outline). Re-exported here so this
// file stays the one dataflow index.
export type { TrackFill, TrackFillGroup } from "@nyc-subwhere/contract";
