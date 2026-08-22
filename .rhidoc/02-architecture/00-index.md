---
title: Architecture
summary: 
tags: []
deps: []
---

# Architecture


| Ref | Item | Kind | Summary | Tags |
|-----|------|------|---------|------|

| doc02.01 | Overview | doc | The runtime model — pull-snapshot the feed, interpolate between keyframes; backend fetch loop and the (open) front-end | architecture, overview, realtime, fetch-loop, interpolation |
| doc02.02 | MTA Resources | doc | Where subway data comes from, its contract and shape, and how a realtime Trip joins static geometry | architecture, mta, gtfs, data-source |
| doc02.03 | Frontend | doc | The frontend stack — MapLibre + Three.js rendering, built with Vite + TypeScript + Biome, no UI framework | architecture, frontend, rendering, maplibre, threejs, vite, typescript |
| doc02.04 | Backend | doc | Cloudflare Worker backed by a single Durable Object that polls the MTA feeds on a 30s alarm and publishes the reshaped frame to KV — fan-in, alert-key custody, insulation, and reshape-once | architecture, backend, cloudflare, worker, durable-object, kv, poller |
| doc02.05 | Geometry Builder | doc | The build-time script that transduces MTA static GTFS into baked web assets — station points, segmented route geometry, and a station→track index — and owns the hard cartography so runtime doesn't | architecture, geometry, build-time, gtfs, script, dev-tooling |
| doc02.06 | Position Estimation | doc | How accurately a train's position can be recovered from the realtime feed — the one hard fact per poll, the observed events diffing manufactures, the interpolation formula, where delays make position unknowable, and how to fold each new frame into the position already shown (forward-only reconciliation) instead of recomputing it and snapping the train backward | architecture, realtime, interpolation, motion, position, prediction, dead-reckoning, research |
| doc02.07 | Junction Tessellation | doc | How to render a network of equal-width track ribbons with seamless merges, branches, and grade-separated crossings — the standard GIS buffer→group-by-grade→boolean-union→triangulate pipeline, why junctions fall out of it for free, the offset/join/union/triangulation formulae, and the silhouette-vs-fill split that keeps per-route color | architecture, geometry, rendering, junctions, cartography, research |
| doc02.08 | Rendering Techniques | doc | A learning-oriented glossary of the graphics and computational-geometry techniques used to draw the network — ribbon offset and boolean union, grade as depth draw-order, transition curves and arc extrapolation, topology inference from polyline soup, linear-reference conform, the caret shader, and the screenshot/debug-pipe tooling. Names the general technique, why it was used here, and where it lives. | graphics, geometry, glossary, rendering, techniques, depth, curves, tessellation, shader |
| doc02.09 | Citi Bike Poller | doc | A second Durable Object polls the Citi Bike GBFS feeds on the backend's alarm pattern and publishes two frames to KV — status split from station info by change rate, ebike counts disambiguated once at the seam | architecture, backend, citibike, gbfs, poller, kv, durable-object |

Topics: architecture, backend, build-time, cartography, citibike, cloudflare, curves, data-source, dead-reckoning, depth, dev-tooling, durable-object, fetch-loop, frontend, gbfs, geometry, glossary, graphics, gtfs, interpolation, junctions, kv, maplibre, motion, mta, overview, poller, position, prediction, realtime, rendering, research, script, shader, techniques, tessellation, threejs, typescript, vite, worker
