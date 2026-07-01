// Stage 2: select canonical shapes (greedy stop-coverage). Per (route,
// direction) keep the fewest shapes that still cover every stop the route
// touches — preserves branches (e.g. the A's two southern legs) while dropping
// the thousands of near-duplicate service variants.

import type { Direction, LngLat } from "@nyc-subwhere/contract";
import { type Normalized, directionOf } from "./gtfs-normalize";

// A representative shape kept for rendering + motion.
export interface Canonical {
  shapeId: string;
  routeId: string;
  direction: Direction;
  color: string;
  points: LngLat[];
  stopIds: string[]; // ordered directional stop_ids on this shape
}

export function selectCanonical(n: Normalized): Canonical[] {
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
