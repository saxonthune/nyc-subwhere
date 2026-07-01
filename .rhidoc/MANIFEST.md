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
| doc01.01 | `01-glossary.md` | Load-bearing domain vocabulary — GTFS-anchored terms, the project's own coined terms, and the ambiguities to watch | product, glossary, vocabulary, gtfs | doc01.02 | doc01.02, doc02.01, doc02.02, doc02.03 | — |
| doc01.02 | `02-development-ethos.md` | How this project is built with an agent — lessons carried from the FIFA-bracketing DA-RESULTS retrospective | product, process, ethos, naming, human-agent | doc01.01 | doc01.01 | — |

## 02-architecture — Architecture

| Ref | File | Summary | Tags | Deps | Refs | Attachments |
|-----|------|---------|------|------|------|-------------|

| doc02.00 | `00-index.md` |  |  | — | — | — |
| doc02.01 | `01-overview.md` | The runtime model — pull-snapshot the feed, interpolate between keyframes; backend fetch loop and the (open) front-end | architecture, overview, realtime, fetch-loop, interpolation | doc02.02, doc01.01 | doc02.03, doc02.04 | — |
| doc02.02 | `02-mta-resources.md` | Where subway data comes from, its contract and shape, and the fetch decisions still open | architecture, mta, gtfs, data-source | doc01.01 | doc02.01, doc02.04 | — |
| doc02.03 | `03-frontend.md` | The frontend stack — MapLibre + Three.js rendering, built with Vite + TypeScript + Biome, no UI framework | architecture, frontend, rendering, maplibre, threejs, vite, typescript | doc01.01, doc02.01 | — | — |
| doc02.04 | `04-backend.md` | Cloudflare Worker as a read-through edge cache in front of the MTA feeds — fan-in, alert-key custody, insulation, and reshape-once | architecture, backend, cloudflare, worker, cache, fetch-loop | doc02.02, doc02.01 | — | — |

## Tag Index

Quick lookup for file-path→doc mapping:

| Tag | Relevant Docs |
|-----|---------------|
| `architecture` | doc02.01, doc02.02, doc02.03, doc02.04 |
| `backend` | doc02.04 |
| `cache` | doc02.04 |
| `cloudflare` | doc02.04 |
| `conventions` | doc00.03 |
| `data-source` | doc02.02 |
| `docs` | doc00.01, doc00.02, doc00.03 |
| `ethos` | doc01.02 |
| `fetch-loop` | doc02.01, doc02.04 |
| `frontend` | doc02.03 |
| `glossary` | doc01.01 |
| `gtfs` | doc01.01, doc02.02 |
| `human-agent` | doc01.02 |
| `interpolation` | doc02.01 |
| `maintenance` | doc00.02 |
| `maplibre` | doc02.03 |
| `meta` | doc00.01 |
| `mta` | doc02.02 |
| `naming` | doc01.02 |
| `overview` | doc02.01 |
| `philosophy` | doc00.02 |
| `process` | doc01.02 |
| `product` | doc01.01, doc01.02 |
| `realtime` | doc02.01 |
| `relational-facts` | doc00.02 |
| `rendering` | doc02.03 |
| `theory` | doc00.01 |
| `threejs` | doc02.03 |
| `typescript` | doc02.03 |
| `vite` | doc02.03 |
| `vocabulary` | doc01.01 |
| `worker` | doc02.04 |
