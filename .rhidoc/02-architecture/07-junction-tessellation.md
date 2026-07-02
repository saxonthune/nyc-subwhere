---
title: Junction Tessellation
summary: How to render a network of equal-width track ribbons with seamless merges, branches, and grade-separated crossings — the standard GIS buffer→group-by-grade→boolean-union→triangulate pipeline, why junctions fall out of it for free, the offset/join/union/triangulation formulae, and the silhouette-vs-fill split that keeps per-route color
tags: [architecture, geometry, rendering, junctions, cartography, research]
deps: [doc02.05, doc02.03, doc01.03]
---

# Junction Tessellation

Research notes on drawing the track network (doc01.03) as filled ribbons that meet
cleanly at junctions. The geometry builder (doc02.05) owns this: it is baked once,
not solved at runtime. This doc records the technique and its formulae so the
pipeline can be rebuilt or retuned without re-deriving them.

## What this answers

- Why per-Segment ribbons overlap at junctions, and why patching each junction by
  hand does not converge.
- The standard way to turn a network of centerlines into one seamless filled
  surface, and why merges, branches, and crossings then require no special cases.
- The offset, join, union, and triangulation formulae the bake needs.
- How to keep per-Route color (candy-cane carets, doc02.03) once the ribbons are
  dissolved into one surface that no longer remembers which Route it came from.

## The problem: equal-width ribbons overlap, they do not tile

Every corridor draws the same width (`halfWidth` each side of its centerline). A
merge is therefore an **overlap**, not a natural tiling: where a branch centerline
runs into a trunk centerline, their two ribbons cover the same ground twice. The
same holds at a branch (one-into-two) and at an at-grade crossing.

Handling each junction as its own case — conforming a branch tail onto the trunk
tangent, lifting it to avoid z-fight, protruding it to run parallel, patching the
gore where floors fail to meet — does not converge. Each fix is tuned against one
camera pose and a threshold that the next junction violates. The thresholds are
symptoms of reconstructing, per junction, a single operation that already has a
closed form over the whole network: **polygon union**.

## The solved approach: buffer, group by grade, union, triangulate

This is the standard GIS road-polygon workflow (buffer the centerlines, dissolve
the overlaps) applied per grade layer:

1. **Buffer** each corridor centerline by `halfWidth` into a ribbon polygon — the
   set of points within `halfWidth` of the polyline (a Minkowski sum with a disc).
2. **Group by grade.** Assign each ribbon a grade band from the baked crossing
   facts (which corridor is *over*, which *under*). Ribbons that share ground but
   sit in different bands go in different groups.
3. **Union (dissolve)** all ribbons *within* a group into one MultiPolygon. This
   is a boolean OR: overlaps collapse, so the merge/branch throat becomes one
   filled region with no seam. The **boundary** of the union is exactly the
   outline — where edges/walls go.
4. **Triangulate** each group's MultiPolygon (outer rings minus holes) into the
   floor mesh, and render group `g` at its band height `y_g`.

Merges, branches, and crossings are not special cases in this pipeline. A merge is
two ribbons whose union happens to overlap; a crossing is two ribbons that land in
different grade groups and so never union. Both are the same two steps as a
straight run.

### Why junctions fall out for free

- **Merge / branch** — the union of the branch ribbon and the trunk ribbon is one
  simply-connected region through the throat. No conform, no lift, no protrusion,
  no gore patch: the fill is whatever the union covers, and the outline is its
  boundary.
- **Grade-separated crossing** — floors are drawn *flat* (no height change at all); grade
  is a **draw order**, not an elevation. Each corridor gets a constant integer grade level:
  one above every corridor it overlaps, computed as a longest-path level over the overlap
  graph (over must exceed under, relaxed to a fixed point; the priority order is total so
  the graph is acyclic). Floors are grouped by level into one mesh per level, and each
  level's material carries a depth-buffer offset (`polygonOffset`, decal-style) that pulls
  higher grades toward the camera. Where two floors overlap, the higher grade wins the
  depth test and shows on top; elsewhere nothing changes. Because the resolution is pure
  draw order, there is no bump, no hover, and no void under a raised floor — the platform
  stays perfectly flat. Overlaps come from two sources (see below), so crossings, merge
  throats, and near-parallel express/local runs all resolve the same way.
- **Walls / edges** — the boundary rings of the dissolved MultiPolygon *are* the
  wall lines. No `count===1` rail bookkeeping to decide which edge is exterior;
  the union already computed the exterior.

## The color problem and the silhouette / fill split

Union loses per-Segment identity: the dissolved surface no longer knows which
Route(s) painted each point, but the caret shader (doc02.03) needs each corridor's
own Route-set to stripe a shared trunk. Resolve by using the union for **silhouette
only** and keeping the per-corridor ribbons for **fill**:

- **Silhouette (union)** — drives the outline geometry (walls / platform edges)
  and, if wanted, a base floor. This is the part that must tile seamlessly.
- **Fill (per-corridor ribbons)** — the colored caret floors, drawn on top,
  carrying each corridor's baked palette. Overlap between them at a throat is
  hidden by the shared silhouette beneath and by the raised-platform framing
  (doc01.03).

This is the right seam anyway: silhouette is a geometry *fact* (where the surface
is), color is a render *policy* (how it is painted). The bake owns the first; the
shader owns the second.

## Order of transformations

The union constrains the pipeline order. Grade must be decided *before* the union,
because it selects which ribbons are allowed to merge; merge-conforming disappears
entirely.

```
partner-fuse corridors        (N+S of one corridor → one centerline)
  → assign grade per ribbon   (crossing over/under; baked fact)
  → buffer each to a polygon  (halfWidth, chosen join type)
  → group by grade
  → union within each group   (dissolve overlaps → MultiPolygon)
  → triangulate + take boundary
```

Contrast the superseded order (conform → crossings → elevation → partner), which
reshaped branch tails *before* it knew the network silhouette — reconstructing the
union one junction at a time.

## Formulae

**Ribbon buffer.** For centerline polyline `P = (p₀…pₙ)` and half-width `w`, the
ribbon is `P ⊕ D_w`, the Minkowski sum with a disc of radius `w` — every point
within `w` of `P`. In practice, offset each edge left and right by `w` along its
unit normal and join at vertices:

- unit tangent of edge `i`: `tᵢ = (pᵢ₊₁ − pᵢ) / |pᵢ₊₁ − pᵢ|`
- unit normal (right-hand): `nᵢ = (tᵢ.y, −tᵢ.x)`
- offset boundary points at `pᵢ`: `pᵢ ± w·nᵢ`

**Vertex join.** At an interior vertex with turn angle `θ` between successive
edges, the outer side needs a join:

- **miter** — extend the two offset lines to their intersection. Miter length
  `= w / sin(θ/2)`; it blows up as `θ→0`, so cap with a miter limit `m` (bevel
  when `1/sin(θ/2) > m`). A road-like default is `m ≈ 2`.
- **round** — fill the outer wedge with an arc of radius `w` centered at the
  vertex. No spikes at any angle; more vertices.
- **bevel** — a single chord across the wedge. Cheapest, slightly faceted.

Round joins are the safe default for a transit ribbon (no miter spikes at sharp
reroutes); miter with a low limit is fine and lighter if curves are gentle.

**Union (dissolve).** Boolean OR of the ribbon polygons. Martinez-Rueda runs in
`O((n+k)·log n)` for `n` total edges and `k` intersections. The result is a
MultiPolygon: outer rings and holes. By the usual convention outer rings wind
counter-clockwise and holes clockwise (signed area `A = ½·Σ(xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)`,
positive = CCW = outer). Holes are interior gaps the network encloses (e.g. a loop
of track around a block).

**Triangulation.** Ear-clipping (earcut) over each outer ring with its holes
threaded in, yielding the floor triangles. Boundary rings, kept separately, are
the edge/wall polylines.

**Grade levels.** Give each corridor `c` an integer `level(c) = max(0, max_{c over u}
level(u) + 1)` — the longest path in the overlap DAG — by relaxing `level[over] ≥
level[under] + 1` to a fixed point, capped at `MAX_LEVEL`. Render level `k` with a depth
offset (`polygonOffset ∝ -k`) so higher levels win the depth test; the floors stay flat at
one height. This is draw-order grade separation: no geometry moves, so no bump/hover/void,
and any overlapping pair with a grade difference stops z-fighting.

**Overlap relations.** Two kinds of overlap feed the DAG. A **crossing** is a true interior
intersection of the centerlines. A **near-parallel overlap** is two different-route
corridors whose centerlines run within `2·halfWidth` (their ribbons overlap) for at least a
minimum length but never cross — express/local pairs. Both add an `over → under` edge (by
the busier-on-top priority), so a pair that overlaps without ever crossing still separates.

## What it replaces

The union pipeline subsumes, as one closed-form operation, the hand-rolled passes
that reconstructed it piecewise: branch-tail conforming, the merge-lift ramp, the
merge protrusion constant, the rail boundary-extraction bookkeeping, and the
per-junction gore patches. Grade separation stays as a baked per-ribbon fact
(which layer), now consumed as the union's grouping key rather than as a per-vertex
elevation ramp welded into each Segment.

## Tooling

Baked in the geometry package (Node), so runtime stays a thin renderer (doc02.05):

- **`polygon-clipping`** (mfogel) — Martinez-Rueda boolean ops on Polygon /
  MultiPolygon with holes; the union/dissolve step. Used behind Turf.js and the
  OSM iD editor, so it is proven on messy real map geometry.
- **`earcut`** (Mapbox) — the triangulation; the standard fast ear-clipper used
  across web mapping.

The offset/buffer itself is either `turf.buffer` (which wraps the same clipper) or
a hand-written offset when join type and end caps must be controlled precisely.

## Sources

- ESRI, *Create Road Polygons from Centerlines* — buffer then dissolve is the
  canonical road-polygon workflow. <https://support.esri.com/en-us/knowledge-base/how-to-create-road-polygons-from-centerlines-in-arcgis--000036180>
- Angus Johnson, *Clipper2* — offsetting (join/end types, miter limit) and the
  overlap-artifact note that motivates unioning per group. <https://www.angusj.com/clipper2/Docs/Overview.htm>
- `polygon-clipping` (Martinez-Rueda-Feito, `O((n+k)log n)`, used by Turf.js and
  OSM iD). <https://github.com/mfogel/polygon-clipping>
- Transit, *How We Built the World's Prettiest Auto-Generated Transit Maps* —
  pixel-space skeletonization + integer-linear-programming line ordering; a
  different (schematic-diagram) aesthetic, but the "detect shared segments
  explicitly, order to minimize crossings" lesson carries. <https://blog.transitapp.com/how-we-built-the-worlds-prettiest-auto-generated-transit-maps-12d0c6fa502f/>
