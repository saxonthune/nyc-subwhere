// Stage 3: segment geometry (cut + conflate). Cut each canonical shape into
// inter-station pieces, then merge pieces that are the same physical track
// (same parent-station pair + direction) across Routes, then hand the keyed
// pieces to the geometric corridor pass (merge-corridors.ts). Colors are
// deduped: same-color routes on a trunk collapse to a solid line;
// different-colored routes yield the stripe set (doc02.05).

import type {
  Direction,
  LngLat,
  SegmentCollection,
} from "@nyc-subwhere/contract";
import { lineString } from "@turf/helpers";
import lineSliceAlong from "@turf/line-slice-along";
import { round6 } from "./geo";
import { type Normalized, parentOf } from "./gtfs-normalize";
import type { Located } from "./locate-stops";
import {
  type MergeReport,
  type SegmentPiece,
  mergeParallelCorridors,
} from "./merge-corridors";

// Peak-express "diamond" services (6X/7X/FX) are separate route_ids whose shapes
// retrace their base route's rails while skipping local stops. On the map they add
// no track their base route doesn't already draw — only long chords that overlap
// (and hide) the local segments. Excluded from display geometry to avoid the
// duplicate; the motion index (buildTracks) still carries them.
const DIAMOND_EXPRESS = new Set(["6X", "7X", "FX"]);

export function buildSegments(
  located: Located[],
  n: Normalized,
): {
  collection: SegmentCollection;
  mergeReport: MergeReport;
  preMerge: SegmentCollection;
} {
  interface Piece {
    routeId: string;
    color: string;
    direction: Direction;
    coords: LngLat[];
  }
  const byKey = new Map<string, Piece[]>();
  for (const { canonical: c, stops } of located) {
    if (DIAMOND_EXPRESS.has(c.routeId)) continue;
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

  const keyed: SegmentPiece[] = [...byKey.values()].map((pieces) => ({
    routes: [...new Set(pieces.map((p) => p.routeId))].sort(),
    colors: [...new Set(pieces.map((p) => p.color))].sort(),
    direction: pieces[0].direction,
    coords: pieces[0].coords,
  }));

  const toFeature = (piece: SegmentPiece) => ({
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: piece.coords.map(
        (p) => [round6(p[0]), round6(p[1])] as LngLat,
      ),
    },
    properties: {
      routes: piece.routes,
      direction: piece.direction,
      colors: piece.colors,
      colorCount: piece.colors.length,
      color0: piece.colors[0],
      color1: piece.colors[1] ?? "",
      color2: piece.colors[2] ?? "",
    },
  });

  // Pre-merge pieces in the final segment schema, so `inspect --file` can diff
  // what mergeParallelCorridors changed (doc02.05) without reconstruction.
  const preMerge: SegmentCollection = {
    type: "FeatureCollection",
    features: keyed.map(toFeature),
  };
  const { pieces: merged, report: mergeReport } = mergeParallelCorridors(keyed);
  const collection: SegmentCollection = {
    type: "FeatureCollection",
    features: merged.map(toFeature),
  };
  return { collection, mergeReport, preMerge };
}
