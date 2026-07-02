---
title: Behaviors
summary: EARS behavioral intent for the Board — render live trips, glide between polls, never render a train at or past a Station it has not been observed to reach (segment-ahead error is fine, station-crossing is not), ride track by stops (off-route reroutes), blink when position is uncertain, reveal directional tracks on zoom, give every route on shared track representation, render the network with depth (raised track, pucks, platform boxes), seat it on grey extruded borough land over a dark-navy water disc that fades into the backdrop, tap to inspect
tags: [product, behaviors, ears, rendering, interaction]
deps: [doc01.01, doc02.01, doc02.03, doc02.05]
---

# Behaviors

The intended behavior of the Board (doc01.01), written in EARS. These state *what*
the app does and *why*, not how — the interpolation math and late-detection
algorithm live in code and in the render contract (`@nyc-subwhere/contract`,
doc02.04), not here. Terms are the glossary's (doc01.01).

## Granularity

These behaviors are declarative but not an exhaustive requirements inventory. State
that the Board does a thing and why; do not enumerate every field, case, or detail
an implementation must satisfy — for instance, a behavior says the inspector reveals
a Station's details, not which specific details it lists. Spelling out every
particular is how the prose drifts out of step with the code.

## Rendering

- The Board shall render every live Trip as a train drawn along its Route.
- The Board shall color each train by its Route, using the Route's own palette.
- The Board shall draw each train as a single elongated rectangular box.

## Motion Between Polls

The feed steps every ~30s but the trains must not (doc02.01).

- While no fresher frame has arrived, the Board shall keep advancing each train's
  Position Estimate along its current Segment by wall-clock time, so motion stays
  smooth between polls.
- When a fresher frame arrives, the Board shall re-anchor each train to it without
  a visible jump.

## Position Honesty

The map is read to decide whether to run for a train, so the costly error is a false
*station* passage — telling a rider a train has left a platform it has not. Between
Stations the feed carries no position, so the rendered train may sit ahead of where it
truly is along a Segment; that error is unavoidable and acceptable. Crossing a Station
the train has not been observed to reach is not.

- If the feed has not observed a train arriving at a Station, then the Board shall not
  render that train at or beyond that Station.
- While a train runs between two Stations, the Board may render it ahead of its true
  position along that Segment, but shall hold it short of the approaching Station until
  arrival there is observed.

## Off-Route Motion

A Trip is colored by its own Route but rides whatever track its current Stops lie
on, so a reroute onto another line renders as that Route's train on the other
line's geometry. Some reroutes cross track the map does not carry; those must read
as deliberately abnormal, never as ordinary travel drawn wrong.

- While a Trip's Stops lie on baked track, the Board shall move it along that track's
  geometry — including track belonging to a Route other than the Trip's own.
- Where a Trip moves between two Stations that no baked track connects, the Board
  shall recognize the Trip as switching lines, interpolate directly between the two
  Stations, and render a distinct animation marking the motion as off-route.

## Unresolvable Trips

Off-route motion needs the endpoint Stations to at least exist in the baked network.
When a Trip names a Stop or Route the network does not carry at all — a station added
since the last asset build, a service the geometry never covered — there is no place
to draw it, so it is dropped rather than guessed. (When new assets are needed:
doc02.05.)

- If a Trip references a Stop or Route absent from the baked network, then the Board
  shall render that train invisible, rather than place it at a guessed position.

## Uncertain Position

Two independent reasons a train's position becomes untrustworthy; both surface as
the same blink, because both mean "the Board no longer knows where this train is."

- If a train reaches the end of its known upcoming Stops before a fresher frame
  arrives, then the Board shall hold it near its next Station and blink it, rather
  than guess past the data.
- Where the worker reports a Trip as stalled, the Board shall blink that train to
  signal a delay, even while frames are still arriving.

## Baked Geometry Contract

The asset pipeline (doc02.05) bakes two geometry sets with different jobs: motion
tracks — one polyline per Route per direction that trains ride — and render
corridors — the conflated lines the map draws, each carrying every sharing Route
and color. The geometry states what shares ground; presentation is the Board's.

- The asset pipeline shall produce both a motion track set and a render corridor set.
- The asset pipeline shall record a render corridor's sharing Routes and colors
  truthfully, however many there are, rather than capping them at what any current
  renderer can draw.
- The Board shall decide how to draw each render corridor from its recorded Routes
  and colors, degrading however it sees fit when a corridor carries more colors
  than a drawing technique supports.

## Track Legibility

The baked network (doc02.05) carries two directions per corridor and trunks shared by
several Routes. How much of that detail the Board reveals scales with zoom, so the city
view stays clean and the street view stays informative.

- While the map is zoomed out, the Board shall draw a corridor's two directions as a
  single line.
- While the map is zoomed in past a legibility threshold, the Board shall separate a
  corridor's two directions into parallel tracks, so a rider can read delays in one
  direction independently of the other.
- Where a stretch of track is shared by more than one Route, the Board shall give every
  sharing Route's color representation along that stretch at every zoom level, so no single
  Route's color hides the others.

## Depth

The network is drawn with real 3D form rather than flat overlays (doc02.03): each Route's
track is raised from the ground, and each Station is a puck sitting above a platform box.
Zooming in trades the puck's map-marker role for an unobstructed look at the track passing
over the platform.

- The Board shall draw each Route's track.
- The Board shall render each Route's track with 3D relief, raised from the ground rather
  than drawn as a flat overlay.
- The Board shall render each Station as a 3D puck above a platform box.
- The Board shall seat each Station's puck just above the track — its top clearing the top
  of the track — so that when zoomed out it reads as a point marking the Station on the line.
- The Board shall orient each Station's platform box parallel to the track passing through it.
- While the map is zoomed in past a threshold, the Board shall fade the Station puck toward
  transparent, so that at close zoom the track passes over the platform box with no puck
  occluding them.

## Basemap

The network does not float in a void: it sits on the land, and the land sits on the
water. Both are quiet backdrops drawn beneath everything else. The five boroughs
render as grey land, extruded to a shallow height so it reads as ground with form
rather than a flat fill; beneath the land, a dark-navy disc reads as water, fading to
transparent at its rim so it dissolves into the black backdrop rather than ending at a
hard edge. Only the five boroughs are drawn as land — everything outside them is left
unrendered, so it reads as water by default, and the water needs no source geometry of
its own. The asset pipeline (doc02.05) bakes the borough geometry from a public boundary
source, the same way it bakes the network.

- The asset pipeline shall bake a borough land geometry set from a public NYC borough
  boundary source.
- The Board shall render the five boroughs' land as grey polygons extruded to a
  shallow height.
- The Board shall render water as a dark-navy disc seated just below the borough land,
  fading to transparent at its rim so it dissolves into the backdrop with no hard edge.
- The Board shall leave landmass outside the five boroughs unrendered, so it reads as
  water.
- The Board shall draw the basemap — land and water — below all other geometry, so
  tracks, stations, and trains read above it.

## Interaction

- When a rider selects a train, the Board shall present that Trip's Route,
  direction, destination, and next-Station arrival.

## Inspector

- When a developer clicks a Station's geometry — its puck or platform box — or a
  Route line Segment, the Board shall present a modal inspector panel in the lower
  part of the screen, carrying information sensitive to what was clicked.
- Where the clicked object is a Route line Segment, the inspector shall present
  information about that Segment.
- Where the clicked object is a Station platform, the inspector shall present
  information about that platform.
- Where the clicked object is a train, the inspector shall present information about
  that Trip.

## Advanced Stats

An optional panel, off by default, that a rider can open to see diagnostic
information about the current frame beyond what the map itself shows.

- The Board shall offer a toggleable Advanced Stats panel, hidden by default,
  that a rider can open to inspect diagnostic information about the live frame.
