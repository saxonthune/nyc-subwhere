// Stage 5: ribbon edges (doc02.07) — THE single source of truth for the drawn surface. Offset
// each graded corridor centerline to constant-width left/right edges, tagging every vertex with
// the caret coordinates (along the corridor, across it). build-fill quad-strips these edges into
// the colored floor; build-silhouette caps and unions them into the outline. Because both derive
// from these exact vertices, "the fill doesn't reach the wall" is not expressible.
//
// Constant width (C1): there is no taper — a branch tucks under its trunk by grade draw order,
// not by narrowing — so the ribbon is a plain offset. HALF_WIDTH_M lives here alone now that the
// renderer bakes no geometry; nothing has to be kept "in sync" with it.

import { projectNyc, unprojectNyc } from "./geo";
import type {
  GradedCorridor,
  RibbonPolygon,
  RibbonVertex,
} from "./pipeline-types";

// Half-ribbon width in meters — the stylized platform is far wider than the real track gauge, so
// one constant covers both directions of a corridor with room to spare.
export const HALF_WIDTH_M = 26;

export function buildRibbons(corridors: GradedCorridor[]): RibbonPolygon[] {
  const ribbons: RibbonPolygon[] = [];
  for (const c of corridors) {
    const m = c.centerline.map(projectNyc);
    const n = m.length;
    if (n < 2) continue;
    const along = southOriginArcLength(m);

    const left: RibbonVertex[] = [];
    const right: RibbonVertex[] = [];
    for (let i = 0; i < n; i++) {
      const [nx, ny] = normal(m, i);
      const [cx, cy] = m[i];
      left.push({
        lngLat: unprojectNyc([cx + nx * HALF_WIDTH_M, cy + ny * HALF_WIDTH_M]),
        along: along[i],
        across: HALF_WIDTH_M,
      });
      right.push({
        lngLat: unprojectNyc([cx - nx * HALF_WIDTH_M, cy - ny * HALF_WIDTH_M]),
        along: along[i],
        across: -HALF_WIDTH_M,
      });
    }
    ribbons.push({ corridorId: c.id, grade: c.grade, left, right });
  }
  return ribbons;
}

// Right-hand unit normal of the central-difference tangent at vertex i (projected meters).
function normal(m: [number, number][], i: number): [number, number] {
  const a = m[Math.max(0, i - 1)];
  const b = m[Math.min(m.length - 1, i + 1)];
  const tx = b[0] - a[0];
  const ty = b[1] - a[1];
  const len = Math.hypot(tx, ty) || 1;
  return [ty / len, -tx / len];
}

// Arc length at each vertex measured from the corridor's south end (smaller projected y), so
// both directions of a corridor — and adjacent corridors — keep their carets in phase and
// pointing north where they meet. Matches the renderer's former southOriginArcLength.
function southOriginArcLength(m: [number, number][]): number[] {
  const cum = [0];
  for (let i = 1; i < m.length; i++)
    cum.push(
      cum[i - 1] + Math.hypot(m[i][0] - m[i - 1][0], m[i][1] - m[i - 1][1]),
    );
  const startIsSouth = m[0][1] <= m[m.length - 1][1];
  const total = cum[cum.length - 1];
  return startIsSouth ? cum : cum.map((c) => total - c);
}
