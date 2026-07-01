---
title: Geometry Builder
summary: The build-time script that transduces MTA static GTFS into baked web assets — station points, segmented route geometry, and a station→track index — and owns the hard cartography so runtime doesn't
tags: [architecture, geometry, build-time, gtfs, script, dev-tooling]
deps: [doc02.02, doc02.03, doc01.01]
---

# Geometry Builder

The **geometry builder** is a build-time dev script that turns MTA's static GTFS bundle
(doc02.02) into the ready-to-render network assets the front-end (doc02.03) loads at startup.
It is a transducer: GTFS `.txt` in, baked JSON out. It is **not** part of the running app — the
browser never sees a `.txt` file, and there is no runtime fetch for geometry.

## What This Answers

- What the script consumes and what it plops into the web package's assets.
- Which work is precomputed here (near-static geometry) versus computed at runtime (live motion).
- The hard cartography the script owns so the front-end can stay a thin renderer.

## The Split: Bake Geometry, Compute Motion

The network's shape is near-static — it changes only when MTA republishes the GTFS bundle. So the
script precomputes it once, at build time, and the front-end never recomputes it. The dividing line:

- **Baked here** — Route/track shape, Station positions, and the mapping from a Stop to its
  distance along the track. Deterministic; regenerates only when the bundle changes.
- **Computed at runtime** — each Trip's **Position Estimate**, advanced along its **Segment** by
  wall-clock between polls (doc02.01). This depends on live feed data and cannot be baked.

The script's job is to make runtime interpolation *cheap and dumb*: a lookup of two precomputed
distances and a lerp along a precomputed polyline (see the station→track index below).

## Inputs

The static GTFS bundle (doc02.02), five files:

- `stops.txt` — Station coordinates. NYC carries a parent Station (`location_type=1`) plus its
  directional platforms (`location_type=0`, `parent_station` set). The realtime feed reports the
  **directional** `stop_id`; the rendered dot wants the **parent**. Both are kept.
- `shapes.txt` — the actual geographic polyline of each track run. This *is* the route geometry;
  the script does not synthesize curves, it selects and reshapes MTA's own points.
- `routes.txt` — `route_color` anchors the palette to MTA's data rather than hand-picked hues.
- `trips.txt` — joins a `route_id` to its `shape_id`(s); `shapes.txt` does not name its route.
- `stop_times.txt` — the ordered Stops on each Trip, so the script knows which Stations sit on a
  given shape and in what order.

## Outputs

Baked into the web package's assets, loaded once at startup:

- **Station points** (GeoJSON) — one Point per parent Station; MapLibre draws these as dots.
- **Segment geometry** (GeoJSON) — the network cut into inter-station track Segments, each
  carrying the *set* of Routes that physically traverse it (not one LineString per Route). This
  is what lets shared track render as shared track (doc02.03). **Direction is a first-class
  split**: N and S are kept as separate geometry, never collapsed, so a user can read
  one-direction delays independently. The first cut emits one LineString per canonical shape
  per direction (shared trunks overlap); the route-set merge that enables candy-cane striping is
  a later pass.
- **Station→track index** (JSON) — per track run: the polyline points, the cumulative distance at
  each vertex, and each Stop's distance along it. Runtime interpolation reads this to place a
  Position Estimate along a Segment without touching raw geometry.

The front-end consumes these as MapLibre GeoJSON sources (lines, dots) and as the lookup table the
Three.js train layer interpolates against (doc02.03).

## The Hard Parts It Owns

Product quality lives in these passes; skipping them yields a straight-line hairball, not a map.

- **Shape selection / dedup** — `shapes.txt` holds thousands of `shape_id`s (every service
  variant, terminal, and reroute). The script collapses them to a representative set per Route.
- **Network segmentation** — cut each shape at its Stops, group Segments by physical identity, and
  attach the Route-set to each unique Segment. This is the enabling structure for every
  shared-track rendering (candy-cane stripes for shared trunks; express/local and directional
  splits as offset ribbons — doc02.03). Express/local are distinct shapes but often near-coincident
  centerlines, so separating them visually is a deliberate schematic choice, not free from the data.
- **Linear referencing** — project each Station onto its track polyline and precompute cumulative
  distance, so a Position Estimate is a distance lerp at runtime, not a geometric projection.
- **Station dedup** — collapse directional platforms to the parent Station for drawing, while
  retaining the directional `stop_id`s that the realtime join (doc02.02) needs.

## Data Provenance

The raw GTFS bundle is large (dominated by `stop_times.txt`) and regenerable — it is **not
committed** (gitignored). The derived assets are small (order ~1–2 MB raw) and **committed**, so
builds and deploys are hermetic and geometry changes show up as reviewable diffs.

Redistribution is permitted: the underlying transit data carries no copyleft/share-alike and no
mandatory attribution under either MTA's data-feed terms or NY State's OPEN-NY terms; caching and
hosting derived data on a non-MTA server is explicitly allowed. Two obligations the app must
respect anyway: do **not** imply MTA endorses or officially provides the app, and do **not** reuse
MTA's logo/map graphics or wordmark (separate IP license). A credits line ("Transit data from the
MTA, mta.info/open-data — independent project, not affiliated with or endorsed by the MTA")
belongs in the README and about panel.

## Staleness and Regeneration

The baked assets drift when MTA changes the network — a new or reopened Station, a new or
relettered Route, a permanent shape change. Drift is slow (topology changes on the order of
months/years, unlike the ~30s realtime feed) but silent: at runtime an unbaked `stop_id`/`route_id`
just makes that train invisible (doc01.03), so the app degrades quietly instead of alerting. Two
mechanisms surface that drift so a regenerate happens deliberately rather than by bug report:

- **Coverage monitoring** (signal-driven) — the worker (doc02.04) already sees every live
  `stop_id`/`route_id`; flagging any that the current assets don't carry catches exactly the
  drift that hides trains. Distinguish genuine drift from network the build deliberately never
  covered, so an out-of-scope service doesn't read as staleness.
- **Version check** (heartbeat) — the assets stamp `feedVersion` (from `feed_info.txt`); CI/CD
  compares it against MTA's currently-published bundle and signals when the bundle has moved on.

Regeneration is a deterministic build step, not a migration: refresh the GTFS bundle, re-run the
builder, rebuild the web package. `feedVersion` in the outputs records which bundle any deploy
renders.
