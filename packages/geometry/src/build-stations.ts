// Stage 5: station points. Collapse directional platforms to their parent;
// keep the platform ids the realtime join needs. Emit only parents actually
// touched by a canonical shape.

import type { LngLat, StationCollection } from "@nyc-subwhere/contract";
import type { DirectionLabels } from "./build-geometry";
import { round6 } from "./geo";
import type { Normalized, StopInfo } from "./gtfs-normalize";
import type { Canonical } from "./select-canonical";

export function buildStations(
  canonical: Canonical[],
  n: Normalized,
  labels: Map<string, DirectionLabels>,
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
      .map((info) => {
        const label = labels.get(info.id);
        return {
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
            ...(label?.north ? { northLabel: label.north } : {}),
            ...(label?.south ? { southLabel: label.south } : {}),
          },
        };
      }),
  };
}
