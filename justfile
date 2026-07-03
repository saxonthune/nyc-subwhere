# https://just.systems

default:
    just --list

# Install all workspace dependencies
install:
    pnpm install

# Download + extract the MTA subway static GTFS bundle into data/gtfs/ (gitignored)
fetch-gtfs:
    mkdir -p data/gtfs
    curl -fL -o data/gtfs/google_transit.zip http://web.mta.info/developers/data/nyct/subway/google_transit.zip
    unzip -o data/gtfs/google_transit.zip -d data/gtfs

# Download the MTA Subway Stations dataset (per-direction platform labels) into data/mta/ (gitignored)
fetch-stations:
    mkdir -p data/mta
    curl -fL -o data/mta/stations.csv "https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD"

# Generate committed direction-labels.json (compass + terminal-borough phrasing) from stations.csv + baked track-index.json
gen-direction-labels:
    pnpm --filter @nyc-subwhere/geometry gen-direction-labels

# Build web map geometry assets from the GTFS bundle (needs `just fetch-gtfs` first)
gen-geometry:
    pnpm --filter @nyc-subwhere/geometry build-geometry

# Download the NYC borough boundaries (water excluded) into data/boroughs/ (gitignored)
fetch-boroughs:
    mkdir -p data/boroughs
    curl -fL -o data/boroughs/borough-boundaries.geojson "https://data.cityofnewyork.us/api/geospatial/gthc-hcne?method=export&format=GeoJSON"

# Build the basemap land asset from the borough boundaries (needs `just fetch-boroughs` first)
gen-boroughs:
    pnpm --filter @nyc-subwhere/geometry build-boroughs

# Query baked segments: near <lng,lat> [radiusM] | sep <selA> <selB> | diff | lint | overlap
inspect *ARGS:
    node packages/geometry/scripts/inspect.mjs {{ARGS}}

# Check every baked segment renders a valid tube (no NaN / merge failures)
tube-check:
    node packages/web/scripts/tube-check.mjs

# Screenshot the running dev server at a camera pose (paste the `shot:` line from
# Advanced Stats): just shot <out.png> <lng> <lat> [zoom] [pitch] [bearing]
shot *ARGS:
    node packages/web/scripts/shot-at.mjs {{ARGS}}

# Inspect what the baked graph believes at a junction: --station <name> | --at <lng> <lat> [radiusM]
inspect-junction *ARGS:
    pnpm --filter @nyc-subwhere/geometry exec tsx src/inspect-junction.ts {{ARGS}}

# Probe a live NYCT realtime feed: currentStatus split, dwell, field coverage (default gtfs; `all` for every feed)
feed-probe *ARGS:
    node packages/worker/scripts/feed-probe.mjs {{ARGS}}

# Summarize captured prediction-error metrics (needs the dev file sink populated by `just dev-all`)
metrics-report:
    node packages/web/scripts/metrics-report.mjs

# Summarize the estimator metrics: rendered position vs reality, and visible re-base jumps
estimator-report:
    node packages/web/scripts/estimator-report.mjs

# Run the web app locally (Vite dev server, HMR)
dev:
    pnpm --filter @nyc-subwhere/web dev

# Run the Cloudflare Worker locally on :8788 (serves /api; ASSETS fallback needs `just build` first)
worker:
    pnpm --filter @nyc-subwhere/worker dev

# Run web dev server + Worker together (Ctrl-C stops both)
dev-all:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    just dev &
    just worker &
    wait

# Trigger the deploy workflow on a branch (defaults to current); code is deployed from that ref
deploy branch=`git rev-parse --abbrev-ref HEAD`:
    gh workflow run deploy.yml --ref {{branch}}
    @echo "Dispatched deploy.yml on {{branch}} — watch: gh run watch"

# Build all packages
build:
    pnpm -r run build

# Type-check all packages
typecheck:
    pnpm -r run typecheck

# Lint + format check
lint:
    pnpm run lint
