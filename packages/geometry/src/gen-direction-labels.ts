// Derives fuller directional signage by pairing the MTA compass label (e.g.
// "Uptown"/"Downtown") with the terminal borough(s) of the routes serving each
// platform, so the inspector reads "Uptown & The Bronx" like a real platform sign.
//
// Reads the baked `track-index.json` (run the geometry build first — `just
// gen-geometry`) for who-serves-what and each route's terminal, and the gitignored
// `data/mta/stations.csv` (run `just fetch-stations`) for the compass labels +
// borough. Writes the committed `direction-labels.json` that the geometry build
// consumes as its label source. Committed so the phrasing is reviewable and can be
// hand-edited without re-deriving.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrackIndex } from "@nyc-subwhere/contract";
import { parse as parseSync } from "csv-parse/sync";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STATIONS_CSV = path.join(REPO_ROOT, "data", "mta", "stations.csv");
const TRACK_INDEX = path.join(
  REPO_ROOT,
  "packages",
  "web",
  "src",
  "assets",
  "track-index.json",
);
const LABELS_JSON = path.join(
  REPO_ROOT,
  "packages",
  "geometry",
  "direction-labels.json",
);

const BOROUGH_NAME: Record<string, string> = {
  M: "Manhattan",
  Bx: "The Bronx",
  Bk: "Brooklyn",
  Q: "Queens",
  SI: "Staten Island",
};
const BOROUGH_ORDER = [
  "Manhattan",
  "The Bronx",
  "Brooklyn",
  "Queens",
  "Staten Island",
];

const parentOf = (dirStopId: string): string => dirStopId.slice(0, -1);

interface CsvStation {
  north: string;
  south: string;
  borough: string;
}

async function readStationsCsv(): Promise<Map<string, CsvStation>> {
  const buf = await readFile(STATIONS_CSV);
  const rows = parseSync(buf, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  const out = new Map<string, CsvStation>();
  for (const r of rows) {
    const id = r["GTFS Stop ID"];
    if (!id) continue;
    out.set(id, {
      north: r["North Direction Label"],
      south: r["South Direction Label"],
      borough: r.Borough,
    });
  }
  return out;
}

async function readTrackIndex(): Promise<TrackIndex> {
  return JSON.parse(await readFile(TRACK_INDEX, "utf8")) as TrackIndex;
}

// Only the pure-compass Manhattan labels get the "& borough" treatment; place-name
// labels ("Manhattan","Queens","Last Stop","Ferry","Northbound",…) already name a
// destination and pass through verbatim.
function synthesize(compass: string, boroughs: string[]): string | undefined {
  if (!compass) return undefined;
  if (compass === "Uptown" || compass === "Downtown") {
    return boroughs.length ? `${compass} & ${boroughs.join(" & ")}` : compass;
  }
  return compass;
}

async function main(): Promise<void> {
  const stationsCsv = await readStationsCsv();
  const trackIndex = await readTrackIndex();

  const served = new Map<string, { N: Set<string>; S: Set<string> }>();
  const servedFor = (parent: string) => {
    let s = served.get(parent);
    if (!s) {
      s = { N: new Set<string>(), S: new Set<string>() };
      served.set(parent, s);
    }
    return s;
  };

  for (const track of trackIndex.tracks) {
    const dir = track.direction;
    const stops = track.stops;
    if (stops.length === 0) continue;
    const terminalParent = parentOf(stops[stops.length - 1].stopId);
    const terminalBorough =
      BOROUGH_NAME[stationsCsv.get(terminalParent)?.borough ?? ""];
    if (!terminalBorough) continue;
    for (const stop of stops) {
      servedFor(parentOf(stop.stopId))[dir].add(terminalBorough);
    }
  }

  const out: Record<string, { north?: string; south?: string }> = {};
  for (const [parent, csv] of stationsCsv) {
    const homeBorough = BOROUGH_NAME[csv.borough];
    const s = served.get(parent) ?? {
      N: new Set<string>(),
      S: new Set<string>(),
    };
    const boroughsFor = (compass: string, set: Set<string>): string[] =>
      [...set]
        .filter((b) => b && b !== homeBorough && b !== compass)
        .sort((a, b) => BOROUGH_ORDER.indexOf(a) - BOROUGH_ORDER.indexOf(b));
    const north = synthesize(csv.north, boroughsFor(csv.north, s.N));
    const south = synthesize(csv.south, boroughsFor(csv.south, s.S));
    if (north === undefined && south === undefined) continue;
    const entry: { north?: string; south?: string } = {};
    if (north !== undefined) entry.north = north;
    if (south !== undefined) entry.south = south;
    out[parent] = entry;
  }

  const sorted: Record<string, { north?: string; south?: string }> = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];

  await writeFile(LABELS_JSON, `${JSON.stringify(sorted, null, 2)}\n`);

  console.log(
    `direction-labels: ${Object.keys(sorted).length} stations written ` +
      `(track-index feed ${trackIndex.feedVersion ?? "unknown"}) -> ` +
      `${path.relative(REPO_ROOT, LABELS_JSON)}`,
  );
  console.log(`  127 sample: ${JSON.stringify(sorted["127"])}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
