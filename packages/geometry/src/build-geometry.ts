// Geometry builder (doc02.05): MTA static GTFS -> baked web map assets.
// Pure stage functions (normalize -> selectCanonical -> build{Segments,Tracks,Stations})
// wrapped by an impure shell (readInputs / writeOutputs) that owns all file I/O.

import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Direction,
  LngLat,
  SegmentCollection,
  StationCollection,
  Track,
  TrackIndex,
} from "@nyc-subwhere/contract";
import { lineString } from "@turf/helpers";
import lineSliceAlong from "@turf/line-slice-along";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import { parse } from "csv-parse";
import { parse as parseSync } from "csv-parse/sync";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GTFS_DIR = path.join(REPO_ROOT, "data", "gtfs");
const OUT_DIR = path.join(REPO_ROOT, "packages", "web", "src", "assets");

// --- raw GTFS row shapes (only the fields we read) ---
type Row = Record<string, string>;

// --- normalized, in-memory model ---
interface StopInfo {
  id: string;
  name: string;
  lngLat: LngLat;
  parent: string; // parent station id (itself if it is a parent)
  locationType: string;
}
interface Normalized {
  stops: Map<string, StopInfo>;
  routeColor: Map<string, string>; // route_id -> "#RRGGBB"
  shapePoints: Map<string, LngLat[]>; // shape_id -> ordered polyline
  shapeRoute: Map<string, string>; // shape_id -> route_id
  shapeStops: Map<string, string[]>; // shape_id -> ordered directional stop_ids
  feedVersion: string | null;
}

// A representative shape kept for rendering + motion.
interface Canonical {
  shapeId: string;
  routeId: string;
  direction: Direction;
  color: string;
  points: LngLat[];
  stopIds: string[]; // ordered directional stop_ids on this shape
}

// ---------- helpers ----------

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function haversine(a: LngLat, b: LngLat): number {
  const R = 6_371_000; // meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function cumulative(points: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++)
    out.push(out[i - 1] + haversine(points[i - 1], points[i]));
  return out;
}

// NYCT platform stop_ids carry the direction as a trailing N/S.
function directionOf(stopId: string): Direction | null {
  const last = stopId.at(-1);
  return last === "N" || last === "S" ? last : null;
}

function normalizeColor(raw: string | undefined): string {
  const hex = (raw ?? "").trim();
  return hex ? `#${hex}` : "#888888";
}

// ---------- Stage 1: parse & normalize (fed by the I/O shell) ----------

function normalize(
  stopRows: Row[],
  routeRows: Row[],
  tripRows: Row[],
  shapeRows: Row[],
  repStopTimes: Map<string, string[]>, // representative trip_id -> ordered stop_ids
  feedVersion: string | null,
): Normalized {
  const stops = new Map<string, StopInfo>();
  for (const r of stopRows) {
    stops.set(r.stop_id, {
      id: r.stop_id,
      name: r.stop_name,
      lngLat: [Number(r.stop_lon), Number(r.stop_lat)],
      parent: r.parent_station || r.stop_id,
      locationType: r.location_type || "0",
    });
  }

  const routeColor = new Map<string, string>();
  for (const r of routeRows)
    routeColor.set(r.route_id, normalizeColor(r.route_color));

  const shapePoints = new Map<string, LngLat[]>();
  const grouped = new Map<string, Row[]>();
  for (const r of shapeRows) {
    const g = grouped.get(r.shape_id) ?? [];
    g.push(r);
    grouped.set(r.shape_id, g);
  }
  for (const [shapeId, pts] of grouped) {
    pts.sort(
      (a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence),
    );
    shapePoints.set(
      shapeId,
      pts.map(
        (p) => [Number(p.shape_pt_lon), Number(p.shape_pt_lat)] as LngLat,
      ),
    );
  }

  // shape_id -> route_id, and shape_id -> ordered stops (via one representative trip).
  const shapeRoute = new Map<string, string>();
  const shapeStops = new Map<string, string[]>();
  for (const t of tripRows) {
    if (!t.shape_id) continue;
    if (!shapeRoute.has(t.shape_id)) shapeRoute.set(t.shape_id, t.route_id);
    const stopSeq = repStopTimes.get(t.trip_id);
    if (stopSeq && !shapeStops.has(t.shape_id))
      shapeStops.set(t.shape_id, stopSeq);
  }

  return {
    stops,
    routeColor,
    shapePoints,
    shapeRoute,
    shapeStops,
    feedVersion,
  };
}

// ---------- Stage 2: select canonical shapes (greedy stop-coverage) ----------
// Per (route, direction) keep the fewest shapes that still cover every stop the
// route touches — preserves branches (e.g. the A's two southern legs) while
// dropping the thousands of near-duplicate service variants.

function selectCanonical(n: Normalized): Canonical[] {
  interface Cand {
    shapeId: string;
    routeId: string;
    direction: Direction;
    points: LngLat[];
    stopIds: string[];
  }
  const byGroup = new Map<string, Cand[]>();
  for (const [shapeId, points] of n.shapePoints) {
    const routeId = n.shapeRoute.get(shapeId);
    const stopIds = n.shapeStops.get(shapeId);
    if (!routeId || !stopIds || stopIds.length === 0 || points.length < 2)
      continue;
    const direction = directionOf(stopIds[0]);
    if (!direction) continue;
    const key = `${routeId}|${direction}`;
    const cand: Cand = { shapeId, routeId, direction, points, stopIds };
    (byGroup.get(key) ?? byGroup.set(key, []).get(key))?.push(cand);
  }

  const canonical: Canonical[] = [];
  for (const cands of byGroup.values()) {
    const target = new Set(cands.flatMap((c) => c.stopIds));
    const covered = new Set<string>();
    const pool = [...cands].sort((a, b) => b.stopIds.length - a.stopIds.length);
    while (covered.size < target.size && pool.length > 0) {
      let bestIdx = 0;
      let bestGain = -1;
      for (let i = 0; i < pool.length; i++) {
        const gain = pool[i].stopIds.reduce(
          (g, s) => g + (covered.has(s) ? 0 : 1),
          0,
        );
        if (gain > bestGain) {
          bestGain = gain;
          bestIdx = i;
        }
      }
      if (bestGain <= 0) break;
      const [pick] = pool.splice(bestIdx, 1);
      for (const s of pick.stopIds) covered.add(s);
      canonical.push({
        ...pick,
        color: n.routeColor.get(pick.routeId) ?? "#888888",
      });
    }
  }
  return canonical;
}

// ---------- Locate stops along a canonical shape (shared by Stages 3 + 4) ----------
// Project each stop onto the polyline and record its arc-length. Both the display
// segments (cut here) and the motion index (lerp against here) reference these.

interface LocatedStop {
  stopId: string;
  dist: number; // meters along the polyline
}
interface Located {
  canonical: Canonical;
  cumDist: number[];
  stops: LocatedStop[];
}

function locateStops(c: Canonical, n: Normalized): Located {
  const cumDist = cumulative(c.points);
  const line = lineString(c.points);
  const stops = c.stopIds
    .map((stopId) => {
      const info = n.stops.get(stopId);
      if (!info) return null;
      const snapped = nearestPointOnLine(line, info.lngLat);
      const idx = snapped.properties.index ?? 0;
      const proj = snapped.geometry.coordinates as LngLat;
      return { stopId, dist: cumDist[idx] + haversine(c.points[idx], proj) };
    })
    .filter((s): s is LocatedStop => s !== null)
    .sort((a, b) => a.dist - b.dist);
  return { canonical: c, cumDist, stops };
}

function parentOf(stopId: string, n: Normalized): string {
  return n.stops.get(stopId)?.parent ?? stopId;
}

// ---------- Stage 3: segment geometry (cut + conflate) ----------
// Cut each canonical shape into inter-station pieces, then merge pieces that are
// the same physical track (same parent-station pair + direction) across Routes.
// Colors are deduped: same-color routes on a trunk collapse to a solid line;
// different-colored routes yield the stripe set (doc02.05).

function buildSegments(located: Located[], n: Normalized): SegmentCollection {
  interface Piece {
    routeId: string;
    color: string;
    direction: Direction;
    coords: LngLat[];
  }
  const byKey = new Map<string, Piece[]>();
  for (const { canonical: c, stops } of located) {
    const line = lineString(c.points);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (b.dist - a.dist < 1) continue; // co-located stops; nothing to draw
      const slice = lineSliceAlong(line, a.dist / 1000, b.dist / 1000, {
        units: "kilometers",
      });
      const key = `${parentOf(a.stopId, n)}|${parentOf(b.stopId, n)}|${c.direction}`;
      const piece: Piece = {
        routeId: c.routeId,
        color: c.color,
        direction: c.direction,
        coords: slice.geometry.coordinates as LngLat[],
      };
      (byKey.get(key) ?? byKey.set(key, []).get(key))?.push(piece);
    }
  }

  const features = [...byKey.values()].map((pieces) => {
    const routes = [...new Set(pieces.map((p) => p.routeId))].sort();
    const colors = [...new Set(pieces.map((p) => p.color))].sort();
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: pieces[0].coords.map(
          (p) => [round6(p[0]), round6(p[1])] as LngLat,
        ),
      },
      properties: { routes, colors, direction: pieces[0].direction },
    };
  });
  return { type: "FeatureCollection", features };
}

// ---------- Stage 4: linear-reference index (motion) ----------

function buildTracks(located: Located[], feedVersion: string | null): TrackIndex {
  const tracks: Track[] = located.map(({ canonical: c, cumDist, stops }) => ({
    routeId: c.routeId,
    direction: c.direction,
    points: c.points.map((p) => [round6(p[0]), round6(p[1])] as LngLat),
    cumDist: cumDist.map((d) => Math.round(d)),
    stops: stops.map((s) => ({ stopId: s.stopId, dist: Math.round(s.dist) })),
  }));
  return { feedVersion, tracks };
}

// ---------- Stage 5: station points ----------
// Collapse directional platforms to their parent; keep the platform ids the
// realtime join needs. Emit only parents actually touched by a canonical shape.

function buildStations(
  canonical: Canonical[],
  n: Normalized,
): StationCollection {
  const usedParents = new Set<string>();
  for (const c of canonical) {
    for (const stopId of c.stopIds) {
      const info = n.stops.get(stopId);
      if (info) usedParents.add(info.parent);
    }
  }
  const platforms = new Map<string, string[]>();
  for (const info of n.stops.values()) {
    if (info.locationType === "0" && usedParents.has(info.parent)) {
      (
        platforms.get(info.parent) ??
        platforms.set(info.parent, []).get(info.parent)
      )?.push(info.id);
    }
  }
  return {
    type: "FeatureCollection",
    features: [...usedParents]
      .map((parentId) => n.stops.get(parentId))
      .filter((info): info is StopInfo => info !== undefined)
      .map((info) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [
            round6(info.lngLat[0]),
            round6(info.lngLat[1]),
          ] as LngLat,
        },
        properties: {
          stopId: info.id,
          name: info.name,
          platforms: (platforms.get(info.id) ?? []).sort(),
        },
      })),
  };
}

// ---------- I/O shell ----------

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

  const segments = buildSegments(located, normalized);
  const tracks = buildTracks(located, feedVersion);
  const stations = buildStations(canonical, normalized);

  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUT_DIR, "segments.geojson"), JSON.stringify(segments)),
    writeFile(path.join(OUT_DIR, "stations.geojson"), JSON.stringify(stations)),
    writeFile(path.join(OUT_DIR, "track-index.json"), JSON.stringify(tracks)),
  ]);

  console.log(
    `geometry: ${stations.features.length} stations, ${segments.features.length} segments, ` +
      `${tracks.tracks.length} tracks (feed ${feedVersion ?? "unknown"}) -> ${path.relative(REPO_ROOT, OUT_DIR)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
