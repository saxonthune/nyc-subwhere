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

# Run the web app locally (Vite dev server, HMR)
dev:
    pnpm --filter @nyc-subwhere/web dev

# Run the Cloudflare Worker locally (serves /api; assets need `just build-web` first)
worker:
    pnpm --filter @nyc-subwhere/worker dev

# Build all packages
build:
    pnpm -r run build

# Type-check all packages
typecheck:
    pnpm -r run typecheck

# Lint + format check
lint:
    pnpm run lint
