// Stage 1: parse raw GTFS rows (fed by the I/O shell) into the normalized,
// in-memory model every later stage reads.

import type { Direction, LngLat } from "@nyc-subwhere/contract";

// Raw GTFS row shape (only the fields we read).
export type Row = Record<string, string>;

export interface StopInfo {
  id: string;
  name: string;
  lngLat: LngLat;
  parent: string; // parent station id (itself if it is a parent)
  locationType: string;
}

export interface Normalized {
  stops: Map<string, StopInfo>;
  routeColor: Map<string, string>; // route_id -> "#RRGGBB"
  shapePoints: Map<string, LngLat[]>; // shape_id -> ordered polyline
  shapeRoute: Map<string, string>; // shape_id -> route_id
  shapeStops: Map<string, string[]>; // shape_id -> ordered directional stop_ids
  feedVersion: string | null;
}

// NYCT platform stop_ids carry the direction as a trailing N/S.
export function directionOf(stopId: string): Direction | null {
  const last = stopId.at(-1);
  return last === "N" || last === "S" ? last : null;
}

export function parentOf(stopId: string, n: Normalized): string {
  return n.stops.get(stopId)?.parent ?? stopId;
}

function normalizeColor(raw: string | undefined): string {
  const hex = (raw ?? "").trim();
  return hex ? `#${hex}` : "#888888";
}

export function normalize(
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
