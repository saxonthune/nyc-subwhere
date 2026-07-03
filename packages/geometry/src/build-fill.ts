// Stage 6a: fill mesh (doc02.07). Quad-strip each ribbon's left/right edges into triangles and
// group them by grade level for the renderer's depth-offset draw order. Each vertex carries its
// caret coordinates (along/across) and its owning segment id (palette + picking). This is the
// former renderer buildFloor, moved into the bake and fed the same edges the outline unions.

import type { TrackFill, TrackFillGroup } from "@nyc-subwhere/contract";
import type { RibbonPolygon, RibbonVertex } from "./pipeline-types";

export function buildFill(ribbons: RibbonPolygon[]): TrackFill {
  const byLevel = new Map<number, TrackFillGroup>();
  const groupFor = (level: number): TrackFillGroup => {
    let g = byLevel.get(level);
    if (!g) {
      g = { level, position: [], along: [], across: [], segId: [] };
      byLevel.set(level, g);
    }
    return g;
  };

  for (const r of ribbons) {
    const g = groupFor(r.grade);
    const push = (v: RibbonVertex) => {
      g.position.push(v.lngLat[0], v.lngLat[1]);
      g.along.push(v.along);
      g.across.push(v.across);
      g.segId.push(r.corridorId);
    };
    for (let i = 0; i < r.left.length - 1; i++) {
      push(r.left[i]);
      push(r.right[i]);
      push(r.left[i + 1]);
      push(r.right[i]);
      push(r.right[i + 1]);
      push(r.left[i + 1]);
    }
  }

  // Ascending level so the renderer's polygonOffset stack reads in order.
  const groups = [...byLevel.values()].sort((a, b) => a.level - b.level);
  return { groups };
}
