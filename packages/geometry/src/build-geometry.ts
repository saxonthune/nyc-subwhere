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
import type { SegmentCollection } from "@nyc-subwhere/contract";
import { parse } from "csv-parse";
import { parse as parseSync } from "csv-parse/sync";
import { buildGraph } from "./build-graph";
import { buildSegments } from "./build-segments";
import { buildSilhouette } from "./build-silhouette";
import { buildStations } from "./build-stations";
import { buildTracks } from "./build-tracks";
import { conformTracks } from "./conform-tracks";
import { projectNyc } from "./geo";
import { type Row, normalize } from "./gtfs-normalize";
import { healEndpoints } from "./heal-endpoints";
import { locateStops } from "./locate-stops";
import { selectCanonical } from "./select-canonical";
import { smoothSegments } from "./smooth-segments";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GTFS_DIR = path.join(REPO_ROOT, "data", "gtfs");
const LABELS_JSON = path.join(
  REPO_ROOT,
  "packages",
  "geometry",
  "direction-labels.json",
);
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

export interface DirectionLabels {
  north: string;
  south: string;
}

// Per-direction platform signage from the committed derived-labels file
// (packages/geometry/direction-labels.json, produced by gen-direction-labels),
// keyed by GTFS Stop ID (the parent station id). Optional: an absent file just
// leaves stations without labels, and the web app falls back to Northbound/Southbound.
async function readDirectionLabels(): Promise<Map<string, DirectionLabels>> {
  const labels = new Map<string, DirectionLabels>();
  try {
    const parsed = JSON.parse(await readFile(LABELS_JSON, "utf8")) as Record<
      string,
      { north?: string; south?: string }
    >;
    for (const [id, l] of Object.entries(parsed)) {
      labels.set(id, { north: l.north ?? "", south: l.south ?? "" });
    }
  } catch {
    // Optional dataset; without it stations carry no direction labels.
  }
  return labels;
}

async function readFeedVersion(): Promise<string | null> {
  try {
    const rows = await readCsv("feed_info.txt");
    return rows[0]?.feed_version ?? null;
  } catch {
    return null; // feed_info.txt is optional
  }
}

// Give both directions of each fused corridor the union of their [start, end] taper flags,
// matching ends by proximity (the two directions run in opposite coordinate order, so segment
// i's start co-locates with whichever partner end is nearest). Reading from the input flags
// keeps it order-independent.
function reconcileTaper(
  segments: SegmentCollection,
  partner: number[],
  taper: [boolean, boolean][],
): [boolean, boolean][] {
  const ends = segments.features.map((f) => {
    const c = f.geometry.coordinates;
    return [projectNyc(c[0]), projectNyc(c[c.length - 1])] as const;
  });
  const d2 = (a: readonly [number, number], b: readonly [number, number]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  return taper.map((t, i) => {
    const p = partner[i];
    if (p < 0) return [t[0], t[1]];
    const near = (a: number) => (d2(ends[i][a], ends[p][0]) <= d2(ends[i][a], ends[p][1]) ? 0 : 1);
    return [t[0] || taper[p][near(0)], t[1] || taper[p][near(1)]];
  });
}

async function main(): Promise<void> {
  const [
    stopRows,
    routeRows,
    tripRows,
    shapeRows,
    feedVersion,
    directionLabels,
  ] = await Promise.all([
    readCsv("stops.txt"),
    readCsv("routes.txt"),
    readCsv("trips.txt"),
    readCsv("shapes.txt"),
    readFeedVersion(),
    readDirectionLabels(),
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
    collection: rawSegments,
    mergeReport,
    preMerge,
  } = buildSegments(located, normalized);
  // Extend dangling branch endpoints onto the trunk they merge into (doc02.07), so the
  // silhouette union closes the throat; the `taper` flags tell the renderer which ends are
  // angled merges to narrow to a point (turnout) so the caret floors don't clash. Then Chaikin-
  // smooth every centerline so curves render as arcs, not faceted squiggles (doc02.07).
  const { segments: healed, taper } = healEndpoints(rawSegments);
  const segments = smoothSegments(healed);
  // Junction tessellation (doc02.07): merges/branches are dissolved by the silhouette
  // union, not by reshaping branch tails, so segment geometry is left as-is. `merges`
  // stays empty (the union supersedes per-branch conforming).
  // Conform the motion index to the drawn network (conform-tracks.ts): raw
  // per-route shapes float off the merged tubes over the Manhattan Bridge, so snap
  // each track onto the segment geometry actually rendered for it.
  const rawTracks = buildTracks(located, feedVersion);
  const tracks = {
    ...rawTracks,
    tracks: conformTracks(rawTracks.tracks, segments),
  };
  const stations = buildStations(canonical, normalized, directionLabels);
  // A corridor's two directions merge at the same junctions, so their taper flags must agree:
  // the silhouette unions both direction ribbons while the caret fill draws only one (the
  // partner is skipped), so a taper on one direction alone narrows the fill but leaves the
  // union full-width — the colour then stops short of the platform edge. Reconcile each pair to
  // the union of its flags (matched by co-located ends) before baking silhouette + fill.
  const base = buildGraph(segments);
  const taperFused = reconcileTaper(segments, base.partner, taper);
  const graph = {
    ...base,
    merges: [],
    taper: taperFused,
    silhouette: buildSilhouette(segments, taperFused),
  };

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
      `(${mergeReport.mergedGroups} corridor-merged groups), ` +
      `${graph.crossings.length} crossings, ${graph.silhouette.length} silhouette polygons, ` +
      `${tracks.tracks.length} tracks (feed ${feedVersion ?? "unknown"}) -> ${path.relative(REPO_ROOT, OUT_DIR)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
