// Junction inspector (doc02.05 debugging). Reports what the baked graph believes at
// a location: nearby stations, the segments there (with component + colors), and any
// crossing nodes (with over/under and whether the two sides are the same component).
// So a rendering bug can be traced to the DATA before touching the renderer.
//
//   tsx src/inspect-junction.ts --station "62 St"
//   tsx src/inspect-junction.ts --at -73.9966 40.6266 [radiusMeters]

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  LngLat,
  SegmentCollection,
  TrackGraph,
} from "@nyc-subwhere/contract";
import { projectNyc } from "./geo";

const ASSETS = path.resolve(import.meta.dirname, "../../web/src/assets");

type StationFC = {
  features: {
    geometry: { coordinates: LngLat };
    properties: { name: string; stopId: string };
  }[];
};

function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(ASSETS, name), "utf8")) as T;
}

function distToSeg(
  p: [number, number],
  a: [number, number],
  b: [number, number],
) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToLine(p: [number, number], line: [number, number][]) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length - 1; i++)
    best = Math.min(best, distToSeg(p, line[i], line[i + 1]));
  return best;
}

function main() {
  const args = process.argv.slice(2);
  const stations = load<StationFC>("stations.geojson");
  const segments = load<SegmentCollection>("segments.geojson");
  const graph = load<TrackGraph>("track-graph.json");

  let center: LngLat;
  let radius = 150;
  if (args[0] === "--station") {
    const q = args[1].toLowerCase();
    const hits = stations.features.filter((f) =>
      f.properties.name.toLowerCase().includes(q),
    );
    if (hits.length === 0) {
      console.error(`no station matching "${args[1]}"`);
      process.exit(1);
    }
    console.log(`stations matching "${args[1]}":`);
    for (const h of hits)
      console.log(
        `  ${h.properties.name} (${h.properties.stopId}) @ ${h.geometry.coordinates.join(", ")}`,
      );
    center = hits[0].geometry.coordinates;
    if (args[2]) radius = Number(args[2]);
  } else if (args[0] === "--at") {
    center = [Number(args[1]), Number(args[2])];
    if (args[3]) radius = Number(args[3]);
  } else {
    console.error(
      "usage: --station <name> [radius] | --at <lng> <lat> [radius]",
    );
    process.exit(1);
  }

  const c = projectNyc(center);
  console.log(`\ninspecting ${center.join(", ")} within ${radius} m\n`);

  console.log("stations nearby:");
  for (const f of stations.features) {
    const d = Math.hypot(...sub(projectNyc(f.geometry.coordinates), c));
    if (d <= radius)
      console.log(
        `  ${Math.round(d)}m  ${f.properties.name} (${f.properties.stopId})`,
      );
  }

  console.log("\nsegments nearby (index | routes | dir | colors):");
  segments.features.forEach((f, i) => {
    const proj = f.geometry.coordinates.map(projectNyc) as [number, number][];
    const d = distToLine(c, proj);
    if (d <= radius) {
      const p = f.properties;
      console.log(
        `  ${Math.round(d)}m  #${i}  ${p.routes.join("/")} ${p.direction}  [${p.colors.join(",")}]`,
      );
    }
  });

  console.log("\ncrossings nearby (over vs under):");
  let found = 0;
  for (const x of graph.crossings) {
    const d = Math.hypot(...sub(projectNyc(x.point), c));
    if (d > radius) continue;
    found++;
    const o = segments.features[x.over]?.properties;
    const u = segments.features[x.under]?.properties;
    console.log(
      `  ${Math.round(d)}m  over #${x.over}(${o?.routes.join("/")}) / under #${x.under}(${u?.routes.join("/")})`,
    );
  }
  if (found === 0) console.log("  (none)");
}

function sub(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}

main();
