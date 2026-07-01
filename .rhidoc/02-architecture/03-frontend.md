---
title: Frontend
summary: The frontend stack — MapLibre + Three.js rendering, built with Vite + TypeScript + Biome, no UI framework
tags: [architecture, frontend, rendering, maplibre, threejs, vite, typescript]
deps: [doc01.01, doc02.01]
---

# Frontend

## Rendering Stack

- **MapLibre GL JS** owns the geographic map, camera, and interaction (pan/zoom/pinch, plus
  pitch/bearing for the constrained "some rotation, not full 3D" perspective). It also hosts the
  basemap-toggle: the tron view is a black background with subway lines drawn from static GTFS
  shape geometry; the street view flips on a dark vector basemap beneath the same overlays.
- **Three.js** renders the trains — low-poly bright meshes with bloom for the tron glow — inside
  a MapLibre custom layer, camera-synced to the map.

MapLibre supplies the engine, controls, and layer/style logic; it does not supply tiles. The
tron view needs none (it draws Route geometry itself); the street view needs a dark vector
basemap source, still to be chosen.

## Build Stack

- **Vite** — dev server, bundler, and production build; transpiles TypeScript via esbuild.
- **TypeScript** — esbuild strips types without checking them, so `tsc --noEmit` is the separate
  type-check gate (in the build script / CI), against a `tsconfig.json`.
- **Biome** — lint + format in one tool.

**No UI framework.** MapLibre and Three.js are imperative APIs driven from a render loop; a
reconciler (React/Solid) fights that model. UI chrome — a toggle button, an about panel — is
plain DOM layered over the MapLibre canvas.

The **about** surface is either a toggled overlay `<div>` or a second Vite HTML entry point
(multi-page build, no router) — undecided. A reactive layer earns its place only if UI state
grows past a few panels (line filters, train-detail popups); not before.
