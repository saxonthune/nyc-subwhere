// Post-bake QA for the street grid: verifies the invariants build-streets.ts
// promises about packages/web/src/assets/streets.json — no segment longer
// than CHORD_SPLIT_M (an extract chord, see street-limits.ts), and no vertex
// in New Jersey or on Staten Island. Prints a `just shot` pose per violation
// for in-app review, and exits nonzero so a bad bake fails loudly. Runs
// automatically after every bake (the build-streets package script chains it).

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LngLat, StreetGrid } from "@nyc-subwhere/contract";
import { haversine } from "./geo";
import { CHORD_SPLIT_M } from "./street-limits";

const STREETS_PATH = path.join(
  path.resolve(import.meta.dirname, "../../.."),
  "packages",
  "web",
  "src",
  "assets",
  "streets.json",
);

// West of the Hudson, plus the Newark Bay area further south.
const inNewJersey = ([lon, lat]: LngLat): boolean =>
  (lon < -74.02 && lat > 40.695) || (lon < -74.15 && lat > 40.66);
// Staten Island (excluded from the grid — no Citi Bike there). Brooklyn's
// westernmost shore sits near -74.045, so the box can't clip it.
const onStatenIsland = ([lon, lat]: LngLat): boolean =>
  lon < -74.05 && lat < 40.65;

interface Violation {
  rule: string;
  tier: number;
  line: number;
  at: LngLat;
  detail: string;
}

const grid = JSON.parse(await readFile(STREETS_PATH, "utf8")) as StreetGrid;
const violations: Violation[] = [];
let lineCount = 0;
let segmentCount = 0;

grid.tiers.forEach((lines, tier) => {
  lineCount += lines.length;
  lines.forEach((line, li) => {
    for (const p of line) {
      if (inNewJersey(p))
        violations.push({
          rule: "new-jersey",
          tier,
          line: li,
          at: p,
          detail: "vertex in New Jersey",
        });
      if (onStatenIsland(p))
        violations.push({
          rule: "staten-island",
          tier,
          line: li,
          at: p,
          detail: "vertex on Staten Island",
        });
    }
    for (let i = 0; i + 1 < line.length; i++) {
      segmentCount++;
      const lenM = haversine(line[i], line[i + 1]);
      if (lenM > CHORD_SPLIT_M) {
        const mid: LngLat = [
          (line[i][0] + line[i + 1][0]) / 2,
          (line[i][1] + line[i + 1][1]) / 2,
        ];
        violations.push({
          rule: "chord",
          tier,
          line: li,
          at: mid,
          detail: `${(lenM / 1000).toFixed(2)} km segment (max ${CHORD_SPLIT_M / 1000} km)`,
        });
      }
    }
  });
});

console.log(
  `qa-streets: ${lineCount} lines, ${segmentCount} segments, ${violations.length} violations`,
);
const SHOWN = 30;
for (const v of violations.slice(0, SHOWN)) {
  console.log(
    `  [${v.rule}] tier ${v.tier} line ${v.line}: ${v.detail}` +
      `\n    just shot qa-${v.tier}-${v.line}.png ${v.at[0].toFixed(5)} ${v.at[1].toFixed(5)} 12 45 0`,
  );
}
if (violations.length > SHOWN)
  console.log(`  ... and ${violations.length - SHOWN} more`);
if (violations.length > 0) process.exit(1);
