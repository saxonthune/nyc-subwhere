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

# Build all packages
build:
    pnpm -r run build

# Type-check all packages
typecheck:
    pnpm -r run typecheck

# Lint + format check
lint:
    pnpm run lint
