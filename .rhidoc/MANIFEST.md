# .rhidoc/ Manifest

Machine-readable index for AI navigation. Read this file first, then open only the docs relevant to your query.

**Retrieval strategy:** See doc00.00 (codex index) for how to find and read docs efficiently.

## Column Definitions

- **Ref**: Cross-reference ID (`docXX.YY.ZZ`)
- **File**: Path relative to title directory
- **Summary**: One-line description for semantic matching
- **Tags**: Keywords for file-path→doc mapping
- **Deps**: Doc refs to check when this doc changes
- **Refs**: Reverse deps — docs that list this one in their Deps (computed automatically)
- **Attachments**: Non-md files sharing the doc's numeric prefix. Sidecar artifacts that travel with the doc during structural operations. Purely filesystem-derived; not a frontmatter field.

Orphaned attachments (non-md files with no corresponding root .md) are reported as warnings on stderr during regeneration and do not appear in this table.

## 00-codex — nyc-subwhere

| Ref | File | Summary | Tags | Deps | Refs | Attachments |
|-----|------|---------|------|------|------|-------------|

| doc00.00 | `00-index.md` |  |  | — | — | — |
| doc00.01 | `01-about.md` | Why this workspace exists, how to read it, two-sources-of-truth theory | docs, meta, theory | — | — | — |
| doc00.02 | `02-maintenance.md` | Doc philosophy — docs convert volatile source signals into stable intent; declarative intent, banned patterns, prefer facts to prose (purposed terms, splits with criteria, directional facts), author freely then structure separately, when to grow detail | docs, maintenance, philosophy, relational-facts | — | — | — |
| doc00.03 | `03-conventions.md` | Cross-reference syntax, frontmatter schema, file naming, writing style | docs, conventions | — | — | — |

## 01-product — Product

| Ref | File | Summary | Tags | Deps | Refs | Attachments |
|-----|------|---------|------|------|------|-------------|

| doc01.00 | `00-index.md` |  |  | — | — | — |
| doc01.01 | `01-glossary.md` | Load-bearing domain vocabulary — GTFS-anchored terms, the project's own coined terms, and the ambiguities to watch | product, glossary, vocabulary, gtfs | doc01.02 | doc01.02, doc01.03, doc02.01, doc02.02, doc02.03, doc02.05 | — |
| doc01.02 | `02-development-ethos.md` | How this project is built with an agent — lessons carried from the FIFA-bracketing DA-RESULTS retrospective | product, process, ethos, naming, human-agent | doc01.01 | doc01.01 | — |
| doc01.03 | `03-behaviors.md` | EARS behavioral intent for the Board — render live trips, glide between polls, never render a train at or past a Station it has not been observed to reach (segment-ahead error is fine, station-crossing is not), ride track by stops (off-route reroutes), blink when position is uncertain, reveal directional tracks on zoom, give every route on shared track representation, render the network with depth (raised track, pucks, platform boxes), seat it on grey extruded borough land over a dark-navy water disc that fades into the backdrop, tap to inspect | product, behaviors, ears, rendering, interaction | doc01.01, doc02.01, doc02.03, doc02.05 | doc02.07 | — |

## 02-architecture — Architecture

| Ref | File | Summary | Tags | Deps | Refs | Attachments |
|-----|------|---------|------|------|------|-------------|

| doc02.00 | `00-index.md` |  |  | — | — | — |
| doc02.01 | `01-overview.md` | The runtime model — pull-snapshot the feed, interpolate between keyframes; backend fetch loop and the (open) front-end | architecture, overview, realtime, fetch-loop, interpolation | doc02.02, doc01.01 | doc01.03, doc02.03, doc02.04, doc02.06 | — |
| doc02.02 | `02-mta-resources.md` | Where subway data comes from, its contract and shape, and how a realtime Trip joins static geometry | architecture, mta, gtfs, data-source | doc01.01 | doc02.01, doc02.04, doc02.05, doc02.06 | — |
| doc02.03 | `03-frontend.md` | The frontend stack — MapLibre + Three.js rendering, built with Vite + TypeScript + Biome, no UI framework | architecture, frontend, rendering, maplibre, threejs, vite, typescript | doc01.01, doc02.01 | doc01.03, doc02.05, doc02.07 | — |
| doc02.04 | `04-backend.md` | Cloudflare Worker as a read-through edge cache in front of the MTA feeds — fan-in, alert-key custody, insulation, and reshape-once | architecture, backend, cloudflare, worker, cache, fetch-loop | doc02.02, doc02.01 | — | — |
| doc02.05 | `05-geometry-builder.md` | The build-time script that transduces MTA static GTFS into baked web assets — station points, segmented route geometry, and a station→track index — and owns the hard cartography so runtime doesn't | architecture, geometry, build-time, gtfs, script, dev-tooling | doc02.02, doc02.03, doc01.01 | doc01.03, doc02.07, doc02.08 | — |
| doc02.06 | `06-position-estimation.md` | How accurately a train's position can be recovered from the realtime feed — the one hard fact per poll, the observed events diffing manufactures, the interpolation formula, where delays make position unknowable, and how to fold each new frame into the position already shown (forward-only reconciliation) instead of recomputing it and snapping the train backward | architecture, realtime, interpolation, motion, position, prediction, dead-reckoning, research | doc02.02, doc02.01 | doc02.08 | — |
| doc02.07 | `07-junction-tessellation.md` | How to render a network of equal-width track ribbons with seamless merges, branches, and grade-separated crossings — the standard GIS buffer→group-by-grade→boolean-union→triangulate pipeline, why junctions fall out of it for free, the offset/join/union/triangulation formulae, and the silhouette-vs-fill split that keeps per-route color | architecture, geometry, rendering, junctions, cartography, research | doc02.05, doc02.03, doc01.03 | doc02.08 | — |
| doc02.08 | `08-rendering-techniques.md` | A learning-oriented glossary of the graphics and computational-geometry techniques used to draw the network — ribbon offset and boolean union, grade as depth draw-order, transition curves and arc extrapolation, topology inference from polyline soup, linear-reference conform, the caret shader, and the screenshot/debug-pipe tooling. Names the general technique, why it was used here, and where it lives. | graphics, geometry, glossary, rendering, techniques, depth, curves, tessellation, shader | doc02.05, doc02.07, doc02.06 | — | — |

## Tag Index

Quick lookup for file-path→doc mapping:

| Tag | Relevant Docs |
|-----|---------------|
| `architecture` | doc02.01, doc02.02, doc02.03, doc02.04, doc02.05, doc02.06, doc02.07 |
| `backend` | doc02.04 |
| `behaviors` | doc01.03 |
| `build-time` | doc02.05 |
| `cache` | doc02.04 |
| `cartography` | doc02.07 |
| `cloudflare` | doc02.04 |
| `conventions` | doc00.03 |
| `curves` | doc02.08 |
| `data-source` | doc02.02 |
| `dead-reckoning` | doc02.06 |
| `depth` | doc02.08 |
| `dev-tooling` | doc02.05 |
| `docs` | doc00.01, doc00.02, doc00.03 |
| `ears` | doc01.03 |
| `ethos` | doc01.02 |
| `fetch-loop` | doc02.01, doc02.04 |
| `frontend` | doc02.03 |
| `geometry` | doc02.05, doc02.07, doc02.08 |
| `glossary` | doc01.01, doc02.08 |
| `graphics` | doc02.08 |
| `gtfs` | doc01.01, doc02.02, doc02.05 |
| `human-agent` | doc01.02 |
| `interaction` | doc01.03 |
| `interpolation` | doc02.01, doc02.06 |
| `junctions` | doc02.07 |
| `maintenance` | doc00.02 |
| `maplibre` | doc02.03 |
| `meta` | doc00.01 |
| `motion` | doc02.06 |
| `mta` | doc02.02 |
| `naming` | doc01.02 |
| `overview` | doc02.01 |
| `philosophy` | doc00.02 |
| `position` | doc02.06 |
| `prediction` | doc02.06 |
| `process` | doc01.02 |
| `product` | doc01.01, doc01.02, doc01.03 |
| `realtime` | doc02.01, doc02.06 |
| `relational-facts` | doc00.02 |
| `rendering` | doc01.03, doc02.03, doc02.07, doc02.08 |
| `research` | doc02.06, doc02.07 |
| `script` | doc02.05 |
| `shader` | doc02.08 |
| `techniques` | doc02.08 |
| `tessellation` | doc02.08 |
| `theory` | doc00.01 |
| `threejs` | doc02.03 |
| `typescript` | doc02.03 |
| `vite` | doc02.03 |
| `vocabulary` | doc01.01 |
| `worker` | doc02.04 |
