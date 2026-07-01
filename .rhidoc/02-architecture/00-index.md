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
| doc02.02 | MTA Resources | doc | Where subway data comes from, its contract and shape, and the fetch decisions still open | architecture, mta, gtfs, data-source |
| doc02.03 | Frontend | doc | The frontend stack — MapLibre + Three.js rendering, built with Vite + TypeScript + Biome, no UI framework | architecture, frontend, rendering, maplibre, threejs, vite, typescript |
| doc02.04 | Backend | doc | Cloudflare Worker as a read-through edge cache in front of the MTA feeds — fan-in, alert-key custody, insulation, and reshape-once | architecture, backend, cloudflare, worker, cache, fetch-loop |

Topics: architecture, backend, cache, cloudflare, data-source, fetch-loop, frontend, gtfs, interpolation, maplibre, mta, overview, realtime, rendering, threejs, typescript, vite, worker
