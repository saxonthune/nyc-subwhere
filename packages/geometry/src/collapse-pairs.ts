// The A+B collapse (doc02.07). GTFS ships a shape per direction, so build-segments emits two
// direction-keyed halves for one physical track; they ride ~coincident (a few metres apart,
// far under the 26 m half-ribbon), so drawing both and fusing them at runtime was pure
// reconstruction. Instead, match the antiparallel pair and keep ONE half as the drawn corridor
// centerline — the partner's geometry is redundant. Direction survives only as a pointer back
// to the segment (picking → directional stops); the motion index is built separately and is
// unaffected.
//
// `id` is the kept (owned) segment index, so a pick on the fill reads straight back to
// segmentProps[id] in the web app, and assign-grade can report crossings by segment index.

import type { SegmentCollection } from "@nyc-subwhere/contract";
import { projectNyc } from "./geo";
import type { Corridor, SegRef } from "./pipeline-types";

// Antiparallel halves: same route set, opposite direction, endpoints reversed within this.
const PAIR_MATCH_M = 30;

export function collapsePairs(segments: SegmentCollection): Corridor[] {
  const feats = segments.features;
  const routeKey = feats.map((f) => [...f.properties.routes].sort().join(","));
  const dir = feats.map((f) => f.properties.direction);
  const ends = feats.map((f) => {
    const c = f.geometry.coordinates;
    return { start: projectNyc(c[0]), finish: projectNyc(c[c.length - 1]) };
  });

  // Index southbound halves by route-set so each northbound half finds its twin cheaply.
  const southByKey = new Map<string, number[]>();
  feats.forEach((_, i) => {
    if (dir[i] !== "S") return;
    const g = southByKey.get(routeKey[i]);
    if (g) g.push(i);
    else southByKey.set(routeKey[i], [i]);
  });

  const partner = new Array<number>(feats.length).fill(-1);
  for (let i = 0; i < feats.length; i++) {
    if (dir[i] !== "N" || partner[i] >= 0) continue;
    let best = -1;
    let bestScore = PAIR_MATCH_M * 2;
    for (const j of southByKey.get(routeKey[i]) ?? []) {
      if (partner[j] >= 0) continue;
      // The two directions run in opposite coordinate order, so a match has i's start next to
      // j's finish and i's finish next to j's start.
      const score =
        dist(ends[i].start, ends[j].finish) +
        dist(ends[i].finish, ends[j].start);
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0) {
      partner[i] = best;
      partner[best] = i;
    }
  }

  const corridors: Corridor[] = [];
  for (let i = 0; i < feats.length; i++) {
    const p = partner[i];
    // Own the corridor if one-directional or the lower-indexed half of a pair; the partner's
    // geometry mirrors this one, so it is not drawn.
    if (p >= 0 && i > p) continue;
    const owned = feats[i];
    const halves: SegRef[] = [{ direction: dir[i], segmentIndex: i }];
    if (p >= 0) halves.push({ direction: dir[p], segmentIndex: p });
    corridors.push({
      id: i,
      centerline: owned.geometry.coordinates,
      routes: owned.properties.routes,
      palette: owned.properties.colors,
      halves,
    });
  }
  return corridors;
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
