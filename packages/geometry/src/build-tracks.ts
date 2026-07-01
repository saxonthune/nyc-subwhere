// Stage 4: linear-reference index (motion). Per-route, full geometry — the
// corridor merge never touches this; the web app lerps trains along it.

import type { Track, TrackIndex } from "@nyc-subwhere/contract";
import type { LngLat } from "@nyc-subwhere/contract";
import { round6 } from "./geo";
import type { Located } from "./locate-stops";

export function buildTracks(
  located: Located[],
  feedVersion: string | null,
): TrackIndex {
  const tracks: Track[] = located.map(({ canonical: c, cumDist, stops }) => ({
    routeId: c.routeId,
    direction: c.direction,
    points: c.points.map((p) => [round6(p[0]), round6(p[1])] as LngLat),
    cumDist: cumDist.map((d) => Math.round(d)),
    stops: stops.map((s) => ({ stopId: s.stopId, dist: Math.round(s.dist) })),
  }));
  return { feedVersion, tracks };
}
