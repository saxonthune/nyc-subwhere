// Geometry builder entry (doc02.05): MTA static GTFS -> baked web map assets.
// Pure stage functions, one module each —
//   gtfs-normalize   parse raw GTFS into the in-memory model
//   select-canonical greedy stop-coverage shape selection
//   locate-stops     project stops onto shapes (shared by segments + tracks)
//   build-segments   inter-station cut + station-pair conflation
//   merge-corridors  geometric parallel-corridor conflation (+ merge report)
//   build-tracks     linear-reference motion index
//   build-stations   station points
// — wrapped here by an impure shell (readInputs / writeOutputs) that owns all
// file I/O.

import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse";
import { parse as parseSync } from "csv-parse/sync";
import { buildGraph } from "./build-graph";
import { buildSegments } from "./build-segments";
import { buildStations } from "./build-stations";
import { buildTracks } from "./build-tracks";
import { conformMerges } from "./conform-merges";
import { type Row, normalize } from "./gtfs-normalize";
import { locateStops } from "./locate-stops";
import { selectCanonical } from "./select-canonical";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GTFS_DIR = path.join(REPO_ROOT, "data", "gtfs");
const OUT_DIR = path.join(REPO_ROOT, "packages", "web", "src", "assets");
const REPORT_PATH = path.join(
  REPO_ROOT,
  "packages",
  "geometry",
  "merge-report.json",
);
// Gitignored intermediate artifacts, emitted every build in the segment schema
// so `just inspect ... --file debug/<name>` reads them like the final output.
const DEBUG_DIR = path.join(REPO_ROOT, "packages", "geometry", "debug");

async function readCsv(name: string): Promise<Row[]> {
  const buf = await readFile(path.join(GTFS_DIR, name));
  return parseSync(buf, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Row[];
}

// stop_times.txt is the giant file; stream it and keep only the representative
// trips' rows, so the whole thing never lands in memory at once.
async function readRepStopTimes(
  repTripIds: Set<string>,
): Promise<Map<string, string[]>> {
  const collected = new Map<string, { seq: number; stopId: string }[]>();
  const parser = createReadStream(path.join(GTFS_DIR, "stop_times.txt")).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true }),
  );
  for await (const row of parser as AsyncIterable<Row>) {
    if (!repTripIds.has(row.trip_id)) continue;
    const g = collected.get(row.trip_id) ?? [];
    g.push({ seq: Number(row.stop_sequence), stopId: row.stop_id });
    collected.set(row.trip_id, g);
  }
  const out = new Map<string, string[]>();
  for (const [tripId, rows] of collected) {
    rows.sort((a, b) => a.seq - b.seq);
    out.set(
      tripId,
      rows.map((r) => r.stopId),
    );
  }
  return out;
}

async function readFeedVersion(): Promise<string | null> {
  try {
    const rows = await readCsv("feed_info.txt");
    return rows[0]?.feed_version ?? null;
  } catch {
    return null; // feed_info.txt is optional
  }
}

async function main(): Promise<void> {
  const [stopRows, routeRows, tripRows, shapeRows, feedVersion] =
    await Promise.all([
      readCsv("stops.txt"),
      readCsv("routes.txt"),
      readCsv("trips.txt"),
      readCsv("shapes.txt"),
      readFeedVersion(),
    ]);

  // One representative trip per shape_id — every trip on a shape visits the same
  // stops in the same order, so one is enough to learn the shape's stop sequence.
  const repTripByShape = new Map<string, string>();
  for (const t of tripRows) {
    if (t.shape_id && !repTripByShape.has(t.shape_id))
      repTripByShape.set(t.shape_id, t.trip_id);
  }
  const repStopTimes = await readRepStopTimes(new Set(repTripByShape.values()));

  const normalized = normalize(
    stopRows,
    routeRows,
    tripRows,
    shapeRows,
    repStopTimes,
    feedVersion,
  );
  const canonical = selectCanonical(normalized);
  const located = canonical.map((c) => locateStops(c, normalized));

  const {
    collection: segments,
    mergeReport,
    preMerge,
  } = buildSegments(located, normalized);
  // Reshape branch tails onto the trunks they join before anything downstream reads
  // the geometry, so crossings, elevation, and picking all see the conformed shape.
  const conformedMerges = conformMerges(segments);
  const tracks = buildTracks(located, feedVersion);
  const stations = buildStations(canonical, normalized);
  const graph = buildGraph(segments);

  // Selected canonical shapes as inspectable LineStrings (routes/direction/
  // colors so `inspect` reads them; shapeId/stops for coverage questions).
  const canonicalFc = {
    type: "FeatureCollection" as const,
    features: canonical.map((c) => ({
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: c.points },
      properties: {
        routes: [c.routeId],
        direction: c.direction,
        colors: [c.color],
        colorCount: 1,
        color0: c.color,
        shapeId: c.shapeId,
        stops: c.stopIds.length,
      },
    })),
  };

  await Promise.all([
    mkdir(OUT_DIR, { recursive: true }),
    mkdir(DEBUG_DIR, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(OUT_DIR, "segments.geojson"), JSON.stringify(segments)),
    writeFile(path.join(OUT_DIR, "stations.geojson"), JSON.stringify(stations)),
    writeFile(path.join(OUT_DIR, "track-index.json"), JSON.stringify(tracks)),
    writeFile(path.join(OUT_DIR, "track-graph.json"), JSON.stringify(graph)),
    writeFile(REPORT_PATH, JSON.stringify(mergeReport, null, 2)),
    writeFile(
      path.join(DEBUG_DIR, "canonical.geojson"),
      JSON.stringify(canonicalFc),
    ),
    writeFile(
      path.join(DEBUG_DIR, "pre-merge-segments.geojson"),
      JSON.stringify(preMerge),
    ),
  ]);

  console.log(
    `geometry: ${stations.features.length} stations, ${segments.features.length} segments ` +
      `(${mergeReport.mergedGroups} corridor-merged groups, ${conformedMerges} branch tails conformed), ` +
      `${graph.crossings.length} crossings, ` +
      `${tracks.tracks.length} tracks (feed ${feedVersion ?? "unknown"}) -> ${path.relative(REPO_ROOT, OUT_DIR)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
