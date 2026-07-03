---
title: Rendering Techniques
summary: A learning-oriented glossary of the graphics and computational-geometry techniques used to draw the network — ribbon offset and boolean union, grade as depth draw-order, transition curves and arc extrapolation, topology inference from polyline soup, linear-reference conform, the caret shader, and the screenshot/debug-pipe tooling. Names the general technique, why it was used here, and where it lives.
tags: [graphics, geometry, glossary, rendering, techniques, depth, curves, tessellation, shader]
deps: [doc02.05, doc02.07, doc02.06]
---

# Rendering Techniques

A glossary of the techniques behind the drawn network, written to be learned from: each
entry names the **general technique** (the term you would search for), says what it is in a
sentence, why it was used here, and where it lives. Detail on the junction pipeline is in
doc02.07; the geometry build is doc02.05; motion is doc02.06.

## Geometry: ribbons and tessellation

**Constant-width offset (stroke / Minkowski sum with a disc).** Growing a 1-D centerline into
a 2-D band by pushing each edge out by a fixed distance along its normal and joining at the
vertices — formally the Minkowski sum of the polyline with a disc of radius *w*. This is how a
track centerline becomes a `2w`-wide ribbon. `ClipperOffset` does it with round joins/caps;
`build-ribbons` does the plain per-edge version, tagging each emitted vertex with its
along/across coordinate.

**Boolean polygon union / dissolve.** Merging many overlapping polygons into one, dropping the
interior seams — the "dissolve" of GIS. Unioning every ribbon yields one silhouette in which
merges and branches tile seamlessly, with no per-junction special-casing. We use integer
**Clipper** (`clipper-lib`): the floating-point clipper went non-robust on the dense network,
so coordinates are scaled to integers first. Lives in `build-silhouette`.

**Single source of truth (derive, don't duplicate).** A correctness technique, not a graphics
one: the colored fill and the wall outline are both derived from the *same* tagged ribbon edges,
so they cannot drift out of alignment. The bug it kills ("the fill doesn't reach the wall") was
caused by authoring the ribbon twice — once in the bake, once in the renderer. See doc02.07 §1.

**Quad-strip triangulation.** Turning two parallel edge-vertex lists (left, right) into a
triangle mesh by stitching `(Lᵢ, Rᵢ, Lᵢ₊₁)` / `(Rᵢ, Rᵢ₊₁, Lᵢ₊₁)`. This is how the caret floor
is built from the ribbon edges (`build-fill`).

## Depth and draw order (grade without height)

**Depth bias / polygon offset for coplanar layering.** When two surfaces are exactly coplanar,
the depth buffer can't order them and they "z-fight" (flicker). `polygonOffset` nudges a
surface's stored depth without moving its geometry, so one wins cleanly. We use it to render
**grade as draw order, not height**: every track floor is flat at the same `surfaceY`, and a
higher-grade floor is biased forward so it draws over a lower one — junctions read as
over/under with no bumps or hovering geometry.

**`polygonOffset` has a slope-dependent term (gotcha).** The offset is
`factor · depthSlope + units · ε`. The `factor` term scales with how steeply the surface
recedes from the camera, so at grazing / zoomed-out angles a floor's offset balloons — enough
to beat an un-offset object above it (this is why station pucks sank *under* the tracks). Fix:
give the pucks and trains a *stronger* offset than the deepest floor so they always win. Depth
only, no height change. See `network-layer.ts`.

**Longest-path layering over a DAG.** To assign each corridor an integer grade, build a directed
graph of "A must draw over B" relations (from crossings, sustained near-parallel overlaps, and
branch merges), then set each node's level to the longest path into it — the standard longest-path
/ layered-graph-drawing assignment. Because the priority order is total the graph is acyclic, so
a simple relax-to-fixed-point converges. Lives in `assign-grade` (`build-graph.ts`).

**Match the detection threshold to the real footprint.** A parametric gotcha worth internalizing:
the near-parallel detector must trigger whenever the *ribbons* overlap, i.e. centerlines within
`2 · halfWidth`, not some tighter hand-picked distance — otherwise pairs in the gap band stay
coplanar and z-fight. Keep thresholds tied to the geometry they gate, not to a magic number.

## Curves, smoothing, and transitions

**Subdivision smoothing (Chaikin corner-cutting).** Repeatedly replacing each corner with two
points that cut it, converging to a smooth curve — cheap and stable. Turns the faceted ~10 m
GTFS vertices into arcs. We only cut corners past a small angle threshold so straight runs keep
their vertex count. Lives in `smooth-segments`.

**Tangent / curvature continuity (G1 / G2).** Vocabulary for how cleanly two curves meet: **G1**
= same heading (no kink); **G2** = same heading *and* bend rate (no cusp). Rail easements are
built for G2 ("no cusps"); most of our joins target G1.

**Transition / easement curves (the turnout-lead family).** The curves that rotate a branch's
heading to meet a trunk: **cubic Hermite** (endpoints + tangents, cheap but can overshoot),
**biarc** (two tangent circular arcs — constructible with *no inflection* for a single-sense
turn), and the **clothoid / Euler spiral** (curvature ramps linearly — the real surveyed
rail easement). Instructive failure: a Hermite/biarc that *authored a fresh curve onto the trunk
tangent* discarded the branch's real shape and forced a foreign heading, which the debug view
exposed as a wandering S. See doc02.07.

**Arc extrapolation via least-squares circle fit (Kåsa).** Fitting a circle to a polyline's last
few vertices (the algebraic Kåsa least-squares fit) recovers the arc it is *already on*; marching
forward along that circle *continues its own curvature*. This is how a dangling branch grows a
natural connector into the junction — keeping its shape, only adding the missing tail, rather than
reshaping it. Lives in `build-junctions` (`extendToTrunk`).

## Topology from geometry

**Node inference / snap-noding.** Turning a "soup" of independent polylines into a node-edge
graph by clustering endpoints within a tolerance — the GIS *noding* / planarize-with-snap
operation. GTFS ships one polyline per route-direction and *no* junction topology, so we cluster
corridor endpoints (union-find) to discover where tracks actually meet. Lives in `build-junctions`.

**Classifying by geometry.** Within a junction cluster, the **trunk** is the busiest incident
corridor and **branches** extend onto it; a true **terminus** is told apart from a through-junction
by whether the trunk lies *ahead of* the dangling end (a dot-product sign test). Cheap geometric
predicates standing in for topology the data never carried.

## Conflation and linear referencing

**Parallel-corridor conflation.** Detecting near-parallel lines and merging them into one drawn
ribbon so a shared trunk is drawn once, not stacked N-deep. Uses a median-separation gate with a
long-run exception for the one genuinely-parallel case (the Manhattan Bridge). Lives in
`merge-corridors`.

**Antiparallel pair collapse.** The static GTFS feed ships one shape per *direction*, so a physical
track arrives as two near-coincident opposite-order polylines. Matching and keeping one as the
drawn centerline removes a whole class of "re-fuse the two halves at draw time" work. Lives in
`collapse-pairs`.

**Linear referencing / conform (snap motion to the drawn geometry).** Trains move along a
*linear-reference index* (distance-along-a-polyline with cumulative-distance lookup), separate
from the drawn tubes. Because the drawn network is conflated/merged, the raw per-route shape can
float off the tube it's rendered on, so `conform-tracks` **projects each motion point onto the
rendered geometry** — a nearest-point-on-polyline snap — with a forward-progress guard so the snap
can't introduce a backward spike. Caveat learned: the guard prevents *new* spikes but preserves
pre-existing source-shape kinks (e.g. a 180° reversal already in the raw N shape near Canal St).
Lives in `conform-tracks`; motion model in doc02.06.

## Shading and look

**Procedural caret / chevron shader.** Drawing repeating chevrons in the fragment shader from
per-vertex along/across coordinates instead of a texture: `g = along + |across|·tan(bendDeg)`
gives the chevron's slanted coordinate, `floor(g / spacing) mod count` picks the palette color for
that cell, and a dark line is drawn at each cell seam. Per-vertex `segId` selects the corridor's
route palette, so one shader draws every line's colors. Lives in `track-render.ts`.

**Raised platform with downward-extruded edges.** The silhouette boundary is extruded *down* to
the ground as glowing white vertical faces, reading as a raised platform curb. A side benefit:
putting the bright white on *vertical* faces removed the zoom-out white-shimmer aliasing that a
thin flat outline suffered.

**Luminance-tiered bloom.** One bloom pass over the whole scene, tiered by luminance so trains
glow brightest, then track/stations, then the dim land — instead of a separate glow per role.

## Tooling for a visual pipeline

**Deterministic screenshot harness.** A visual pipeline needs visual regression checks: a
Playwright script drives the running dev server to an exact camera pose via a `window.__map`
debug hook and captures a PNG, so a junction can be re-shot identically before/after a change.
`packages/web/scripts/shot-at.mjs` (`just shot`); paste the `shot:` line from the stats panel.

**Debug pipe views (visualize intermediate pipeline stages).** The bake publishes a `debug-graph`
of named polyline layers — e.g. corridor centerlines *before* vs *after* junction synthesis — that
the web app draws as skinny 3-D tubes via a menu toggle that hides the tracks. Making a hidden
intermediate *directly visible* is what turned "the junction looks wrong" into "the centerline
does an S here" — the fix followed immediately. Layers are published in `build-geometry`; rendered
in `network-layer.ts`; drive it in a screenshot with `shot-at.mjs`'s `debugCycles` argument.
