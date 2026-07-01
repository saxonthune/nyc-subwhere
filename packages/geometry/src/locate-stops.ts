// Locate stops along a canonical shape (shared by the segment and track
// stages). Project each stop onto the polyline and record its arc-length. Both
// the display segments (cut here) and the motion index (lerp against here)
// reference these.

import type { LngLat } from "@nyc-subwhere/contract";
import { lineString } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import { cumulative, haversine } from "./geo";
import type { Normalized } from "./gtfs-normalize";
import type { Canonical } from "./select-canonical";

export interface LocatedStop {
  stopId: string;
  dist: number; // meters along the polyline
}

export interface Located {
  canonical: Canonical;
  cumDist: number[];
  stops: LocatedStop[];
}

export function locateStops(c: Canonical, n: Normalized): Located {
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
