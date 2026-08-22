// Street-grid builder: OpenStreetMap roads (BBBike NewYork shapefile extract,
// data/osm/) -> baked street polylines for Bike View's backdrop grid. Like
// build-boroughs.ts, a standalone transducer: read one local file, classify by
// road class into tiers, clip to the boroughs, simplify + round, write.
//
// Source: https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.shp.zip
// (OpenStreetMap data, © OpenStreetMap contributors, ODbL). Names and all
// other attributes stay in the raw extract; the baked asset carries only
// coordinates grouped by tier.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LngLat, StreetGrid } from "@nyc-subwhere/contract";
import * as shapefile from "shapefile";
import { haversine, projectNyc, round6 } from "./geo";
import { CHORD_SPLIT_M } from "./street-limits";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ROADS_SHP = path.join(
  REPO_ROOT,
  "data",
  "osm",
  "NewYork-shp",
  "shape",
  "roads.shp",
);
// Clip against the already-baked borough polygons rather than the raw boundary
// file: coarser rings make the point-in-polygon tests cheap, and a road kept by
// the simplified shoreline is by definition one that lands on the drawn plate.
const BOROUGHS_PATH = path.join(
  REPO_ROOT,
  "packages",
  "web",
  "src",
  "assets",
  "boroughs.geojson",
);
const OUT_PATH = path.join(
  REPO_ROOT,
  "packages",
  "web",
  "src",
  "assets",
  "streets.json",
);

// Streets are a backdrop, never measured against (same stance as the land), so
// a coarse simplification keeps the asset small.
const SIMPLIFY_TOLERANCE_M = 10;

// Clipping is per vertex, splitting a road where it leaves the boroughs — but an
// off-borough run this short (along-road meters) is kept when the road comes
// back, so bridges span their water gap. Sized past the Verrazzano's, the
// longest such crossing; the extract's straight "shortcut" chords (a way whose
// nodes outside the extract region were dropped, joining the survivors with one
// long segment) run tens of kilometers and always split.
const BRIDGE_GAP_M = 4000;

// OSM highway class -> tier. Largest roads first so the renderer can drop the
// tail tiers when zoomed out. Everything absent (footways, service alleys,
// paths, steps, cycleways...) is dropped: at Bike View's zoom range they read
// as noise, not grid.
const TIER_BY_TYPE = new Map<string, number>([
  ["motorway", 0],
  ["motorway_link", 0],
  ["trunk", 0],
  ["trunk_link", 0],
  ["primary", 1],
  ["primary_link", 1],
  ["secondary", 1],
  ["secondary_link", 1],
  ["tertiary", 2],
  ["tertiary_link", 2],
  ["residential", 2],
  ["unclassified", 2],
  ["living_street", 2],
]);
const TIER_COUNT = 3;

interface BoroughFeature {
  geometry: { type: "Polygon"; coordinates: LngLat[][] };
  properties: { borough: string };
}

// Bike View is Citi Bike's map, and Citi Bike doesn't operate on Staten
// Island, so its street grid is dropped: the plate stays blank there. Also
// removes every extract chord with a Staten Island endpoint.
const EXCLUDED_BOROUGHS = new Set(["Staten Island"]);

// A borough outer ring with its bounding box, for fast reject before the
// point-in-polygon test. Holes are ignored: a street inside a park cutout is
// still an NYC street.
interface ClipRing {
  ring: LngLat[];
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function loadClipRings(features: BoroughFeature[]): ClipRing[] {
  const rings: ClipRing[] = [];
  for (const f of features) {
    if (EXCLUDED_BOROUGHS.has(f.properties.borough)) continue;
    const ring = f.geometry.coordinates[0];
    if (!ring || ring.length < 3) continue;
    let minLon = Number.POSITIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    rings.push({ ring, minLon, minLat, maxLon, maxLat });
  }
  return rings;
}

function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function inBoroughs(p: LngLat, rings: ClipRing[]): boolean {
  for (const r of rings) {
    if (
      p[0] < r.minLon ||
      p[0] > r.maxLon ||
      p[1] < r.minLat ||
      p[1] > r.maxLat
    )
      continue;
    if (pointInRing(p, r.ring)) return true;
  }
  return false;
}

// Clip one road to the boroughs: trim the off-borough tails, and split at any
// interior off-borough run longer than BRIDGE_GAP_M. Runs at or under the gap
// (river crossings) are kept intact so bridges stay drawn over the water.
// Independently, any single segment over CHORD_SPLIT_M is an extract chord
// (see street-limits.ts) and splits regardless of where its endpoints land —
// both ends of a chord usually sit on boroughs, so the gap test never sees it.
function clipToBoroughs(part: LngLat[], rings: ClipRing[]): LngLat[][] {
  const inside = part.map((p) => inBoroughs(p, rings));
  const insideIdx: number[] = [];
  inside.forEach((v, i) => {
    if (v) insideIdx.push(i);
  });
  if (insideIdx.length < 2) return [];

  const pieces: LngLat[][] = [];
  let start = insideIdx[0];
  let prev = insideIdx[0];
  for (const i of insideIdx.slice(1)) {
    let split = false;
    if (i > prev + 1) {
      let gapM = 0;
      let maxSegM = 0;
      for (let k = prev; k < i; k++) {
        const d = haversine(part[k], part[k + 1]);
        gapM += d;
        if (d > maxSegM) maxSegM = d;
      }
      split = gapM > BRIDGE_GAP_M || maxSegM > CHORD_SPLIT_M;
    } else {
      split = haversine(part[prev], part[i]) > CHORD_SPLIT_M;
    }
    if (split) {
      if (prev > start) pieces.push(part.slice(start, prev + 1));
      start = i;
    }
    prev = i;
  }
  if (prev > start) pieces.push(part.slice(start, prev + 1));
  return pieces;
}

// Perpendicular distance (meters) from p to segment a->b in the local
// projection — same measure build-boroughs.ts uses for the shoreline.
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

// Douglas-Peucker on an open polyline, endpoints pinned.
function simplifyLine(line: LngLat[], tol: number): LngLat[] {
  if (line.length <= 2) return line;
  const keep = new Array<boolean>(line.length).fill(false);
  keep[0] = keep[line.length - 1] = true;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const span = stack.pop();
    if (!span) break;
    const [s, e] = span;
    let maxD = -1;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistM(line[i], line[s], line[e]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol && maxI > 0) {
      keep[maxI] = true;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  // Simplification must not merge short segments back into a chord-length one:
  // re-keep a middle vertex wherever the output segment would exceed
  // CHORD_SPLIT_M, so the invariant clipToBoroughs established survives into
  // the baked asset (where qa-streets.ts checks it).
  let capped = true;
  while (capped) {
    capped = false;
    let last = 0;
    for (let i = 1; i < line.length; i++) {
      if (!keep[i]) continue;
      if (i > last + 1 && haversine(line[last], line[i]) > CHORD_SPLIT_M) {
        keep[Math.floor((last + i) / 2)] = true;
        capped = true;
      }
      last = i;
    }
  }
  return line.filter((_, i) => keep[i]);
}

async function main(): Promise<void> {
  const boroughs = JSON.parse(await readFile(BOROUGHS_PATH, "utf8")) as {
    features: BoroughFeature[];
  };
  const clipRings = loadClipRings(boroughs.features);

  const tiers: LngLat[][][] = Array.from({ length: TIER_COUNT }, () => []);
  const source = await shapefile.open(
    ROADS_SHP,
    ROADS_SHP.replace(/\.shp$/, ".dbf"),
  );
  let read = 0;
  let keptClass = 0;
  let keptClip = 0;
  for (;;) {
    const r = await source.read();
    if (r.done) break;
    read++;
    const tier = TIER_BY_TYPE.get(
      String((r.value.properties as { type?: string } | null)?.type ?? ""),
    );
    if (tier == null) continue;
    keptClass++;

    const geom = r.value.geometry;
    const parts: LngLat[][] =
      geom?.type === "LineString"
        ? [geom.coordinates as LngLat[]]
        : geom?.type === "MultiLineString"
          ? (geom.coordinates as LngLat[][])
          : [];
    for (const part of parts) {
      if (part.length < 2) continue;
      for (const piece of clipToBoroughs(part, clipRings)) {
        keptClip++;
        tiers[tier].push(
          simplifyLine(piece, SIMPLIFY_TOLERANCE_M).map(
            ([lon, lat]): LngLat => [round6(lon), round6(lat)],
          ),
        );
      }
    }
  }

  const out: StreetGrid = { tiers };
  const json = JSON.stringify(out);
  await writeFile(OUT_PATH, json);
  const counts = tiers.map((t) => t.length).join("/");
  console.log(
    `read ${read} roads, ${keptClass} in tiered classes, ${keptClip} on the boroughs`,
  );
  console.log(
    `wrote ${OUT_PATH}: tiers ${counts}, ${(json.length / 1e6).toFixed(1)} MB`,
  );
}

await main();
