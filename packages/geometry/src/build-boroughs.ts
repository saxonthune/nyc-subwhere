// Basemap builder (doc02.05): NYC borough boundary GeoJSON -> baked land polygons
// for the web map. A separate, simpler transducer than build-geometry.ts: read one
// public boundary file, keep only the five borough shapes, simplify + round, write.
// The water in the basemap needs no geometry — everything outside these polygons
// reads as water — so this script bakes only the land.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LngLat } from "@nyc-subwhere/contract";
import { projectNyc, round6 } from "./geo";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const IN_PATH = path.join(
  REPO_ROOT,
  "data",
  "boroughs",
  "borough-boundaries.geojson",
);
const OUT_DIR = path.join(REPO_ROOT, "packages", "web", "src", "assets");

// The land is a static grey backdrop, never measured against, so a coarse shoreline
// is fine and keeps the asset small (the raw file is ~3 MB of dense coastline).
const SIMPLIFY_TOLERANCE_M = 15;

type Ring = LngLat[];

interface InputFeature {
  properties: { boroname?: string };
  geometry:
    | { type: "Polygon"; coordinates: Ring[] }
    | { type: "MultiPolygon"; coordinates: Ring[][] };
}

// Perpendicular distance (meters) from p to the segment a->b, in the local
// equirectangular projection. Degenerate segment (a==b, as at a closed ring's
// coincident endpoints) falls back to point distance.
function perpDistM(p: LngLat, a: LngLat, b: LngLat): number {
  const [px, py] = projectNyc(p);
  const [ax, ay] = projectNyc(a);
  const [bx, by] = projectNyc(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Douglas-Peucker with both endpoints pinned. Rings arrive closed (first == last),
// so pinning keeps them closed; the first split falls on the vertex farthest from
// that coincident endpoint, and recursion proceeds on proper sub-segments.
function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Array<boolean>(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const span = stack.pop();
    if (!span) break;
    const [lo, hi] = span;
    let maxD = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistM(ring[i], ring[lo], ring[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx !== -1) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

const roundRing = (r: Ring): Ring => r.map(([x, y]) => [round6(x), round6(y)]);

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(IN_PATH, "utf8")) as {
    features: InputFeature[];
  };

  // Flatten every MultiPolygon into standalone Polygon features so the renderer
  // can triangulate each ring set independently (outer + holes) without carrying
  // multi-part semantics.
  const features = [];
  for (const f of raw.features) {
    const borough = f.properties.boroname ?? "";
    const polys =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates]
        : f.geometry.coordinates;
    for (const poly of polys) {
      const rings = poly
        .map((r) => roundRing(simplifyRing(r, SIMPLIFY_TOLERANCE_M)))
        .filter((r) => r.length >= 4); // a polygon ring needs 3 distinct points + closure
      if (rings.length === 0) continue;
      features.push({
        type: "Feature" as const,
        geometry: { type: "Polygon" as const, coordinates: rings },
        properties: { borough },
      });
    }
  }

  const fc = { type: "FeatureCollection" as const, features };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "boroughs.geojson"), JSON.stringify(fc));

  const verts = features.reduce(
    (n, f) => n + f.geometry.coordinates.reduce((m, r) => m + r.length, 0),
    0,
  );
  console.log(
    `boroughs: ${features.length} polygons, ${verts} vertices -> ${path.relative(REPO_ROOT, OUT_DIR)}/boroughs.geojson`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
