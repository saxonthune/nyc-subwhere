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
| doc02.04 | Backend | doc | Cloudflare Worker as a read-through edge cache in front of the MTA feeds — fan-in, alert-key custody, insulation, and reshape-once | architecture, backend, cloudflare, worker, cache, fetch-loop |
| doc02.05 | Geometry Builder | doc | The build-time script that transduces MTA static GTFS into baked web assets — station points, segmented route geometry, and a station→track index — and owns the hard cartography so runtime doesn't | architecture, geometry, build-time, gtfs, script, dev-tooling |

Topics: architecture, backend, build-time, cache, cloudflare, data-source, dev-tooling, fetch-loop, frontend, geometry, gtfs, interpolation, maplibre, mta, overview, realtime, rendering, script, threejs, typescript, vite, worker
