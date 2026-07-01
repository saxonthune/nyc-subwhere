// Stage 3b: geometric parallel-corridor conflation.
//
// Station-pair keying (build-segments.ts) merges routes that share a
// consecutive station pair. It cannot see two routes on the same physical
// alignment bracketed by *different* stations — e.g. west of Hoyt-Schermerhorn
// the pure-G piece (Bergen St -> Hoyt) and the A/C piece (Jay St -> Hoyt) run
// the same rails for ~850 m but share only the Hoyt node, so they render as
// stacked overlapping lines instead of a stripe. This pass detects shared
// ground purely geometrically and merges it, cutting pieces where the sharing
// starts/stops so the diverging tails stay separate.
//
// Matching ignores the nominal N/S direction label — it does not track compass
// heading through junctions (G "N" runs geometrically codirectional with A/C
// "S" at Hoyt). Only *codirectional* geometry merges: each corridor keeps its
// two antiparallel features, so the zoom-in line-offset direction split
// (network-style.ts) still fans them apart unchanged.
//
// Merging G with A/C here is a deliberate zoomed-out simplification the map
// wants, not a claim of shared rail (they are separate tracks at Hoyt).

import type { Direction, LngLat } from "@nyc-subwhere/contract";
import { lineString } from "@turf/helpers";
import lineSliceAlong from "@turf/line-slice-along";
import { cumulative, projectNyc, round6 } from "./geo";

const CORRIDOR_EPS_M = 30; // max cross-track separation to count as same ground
const CORRIDOR_STEP_M = 10; // densification sample spacing
const CORRIDOR_BEARING_COS = Math.cos((25 * Math.PI) / 180);
// Shorter co-located runs are noise — station throats where consecutive pieces
// of the same line brush past each other, or junction crossings — not corridors.
const CORRIDOR_MIN_OVERLAP_M = 100;
const CORRIDOR_MIN_LINK_M = 50; // min matched length to union two sub-pieces
// A run only counts as shared ground if its median separation is near zero.
// Distinct parallel structures sit apart the whole way (Times Sq 7 Av vs
// Broadway ~9 m, Manhattan Bridge sides ~22 m), and a shallow crossing's
// separation is V-shaped — near 0 at the crossing, ε at the run's ends —
// so its median lands around ε/2 ≈ 15 m. Alignments that truly coincide
// (Hoyt, CPW, QBL, J/M/Z) all measure ≤ ~5 m.
const CORRIDOR_MAX_MEDIAN_SEP_M = 6;

// The unit the pass consumes and produces: one drawable polyline with the
// routes/colors that run it. build-segments.ts emits these as features.
export interface SegmentPiece {
  routes: string[];
  colors: string[];
  direction: Direction;
  coords: LngLat[];
}

// Sidecar written next to the package so every gen-geometry run explains what
// the corridor pass merged (and how confidently) without re-deriving it from
// the baked geojson. Inspect with `just inspect`.
export interface MergeGroupReport {
  routes: string[];
  direction: Direction;
  colors: string[];
  lengthM: number;
  mid: LngLat;
  members: { routes: string[]; direction: Direction; arcM: [number, number] }[];
  separationM: { min: number; p50: number; max: number };
}
export interface MergeReport {
  piecesIn: number;
  featuresOut: number;
  mergedGroups: number;
  groups: MergeGroupReport[];
}

export function mergeParallelCorridors(pieces: SegmentPiece[]): {
  pieces: SegmentPiece[];
  report: MergeReport;
} {
  // 1. Densify every piece into samples carrying arc position + local heading.
  interface Sample {
    piece: number;
    arc: number;
    x: number;
    y: number;
    ux: number;
    uy: number;
  }
  const samples: Sample[] = [];
  const cums = pieces.map((p) => cumulative(p.coords));
  const totals = cums.map((c) => c[c.length - 1]);
  for (let i = 0; i < pieces.length; i++) {
    const cum = cums[i];
    const proj = pieces[i].coords.map(projectNyc);
    let k = 0;
    for (
      let arc = CORRIDOR_STEP_M / 2;
      arc < totals[i];
      arc += CORRIDOR_STEP_M
    ) {
      while (cum[k + 1] < arc) k++;
      const span = cum[k + 1] - cum[k];
      const [ax, ay] = proj[k];
      const [bx, by] = proj[k + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (span <= 0 || len === 0) continue;
      const t = (arc - cum[k]) / span;
      samples.push({
        piece: i,
        arc,
        x: ax + dx * t,
        y: ay + dy * t,
        ux: dx / len,
        uy: dy / len,
      });
    }
  }

  // 2. Spatial hash (ε-cells) for O(n) neighbor lookup across ~1100 pieces.
  const cell = (v: number) => Math.floor(v / CORRIDOR_EPS_M);
  const grid = new Map<string, number[]>();
  samples.forEach((s, idx) => {
    const key = `${cell(s.x)}:${cell(s.y)}`;
    (grid.get(key) ?? grid.set(key, []).get(key))?.push(idx);
  });

  // 3. Per sample: nearest codirectional sample of each other piece within ε.
  interface MatchPair {
    ai: number;
    aj: number;
    d: number;
  }
  const matches = new Map<number, Map<number, MatchPair[]>>();
  for (const s of samples) {
    const best = new Map<number, { d2: number; aj: number }>();
    const cx = cell(s.x);
    const cy = cell(s.y);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const ti of grid.get(`${gx}:${gy}`) ?? []) {
          const o = samples[ti];
          if (o.piece === s.piece) continue;
          const d2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
          if (d2 > CORRIDOR_EPS_M ** 2) continue;
          if (s.ux * o.ux + s.uy * o.uy < CORRIDOR_BEARING_COS) continue;
          const b = best.get(o.piece);
          if (!b || d2 < b.d2) best.set(o.piece, { d2, aj: o.arc });
        }
      }
    }
    for (const [j, b] of best) {
      const byJ =
        matches.get(s.piece) ?? matches.set(s.piece, new Map()).get(s.piece);
      const list = byJ?.get(j) ?? byJ?.set(j, []).get(j);
      list?.push({ ai: s.arc, aj: b.aj, d: Math.sqrt(b.d2) });
    }
  }

  // 4. Per (i, j): contiguous matched runs along i. Runs that survive the
  //    minimum-overlap filter yield cut points on i and a link used for
  //    grouping; shorter runs are discarded entirely so a brief station-throat
  //    brush can neither cut a piece nor glue two pieces together.
  const cutsByPiece: number[][] = pieces.map(() => []);
  const links: { i: number; j: number; pairs: MatchPair[] }[] = [];
  for (const [i, byJ] of matches) {
    for (const [j, run] of byJ) {
      run.sort((a, b) => a.ai - b.ai);
      let start = 0;
      const flush = (end: number) => {
        const pairs = run.slice(start, end + 1);
        const a0 = pairs[0].ai;
        const a1 = pairs[pairs.length - 1].ai;
        if (a1 - a0 < CORRIDOR_MIN_OVERLAP_M) return;
        const ds = pairs.map((p) => p.d).sort((x, y) => x - y);
        if (ds[Math.floor(ds.length / 2)] > CORRIDOR_MAX_MEDIAN_SEP_M) return;
        cutsByPiece[i].push(a0 - CORRIDOR_STEP_M / 2, a1 + CORRIDOR_STEP_M / 2);
        links.push({ i, j, pairs });
      };
      for (let k = 1; k < run.length; k++) {
        if (run[k].ai - run[k - 1].ai > 3 * CORRIDOR_STEP_M) {
          flush(k - 1);
          start = k;
        }
      }
      flush(run.length - 1);
    }
  }

  // 5. Cut each piece at its overlap boundaries -> sub-pieces.
  interface Sub {
    piece: number;
    a0: number;
    a1: number;
  }
  const subs: Sub[] = [];
  const subsOfPiece: { a1: number; id: number }[][] = [];
  for (let i = 0; i < pieces.length; i++) {
    const interior = [...new Set(cutsByPiece[i])]
      .filter((a) => a > CORRIDOR_STEP_M && a < totals[i] - CORRIDOR_STEP_M)
      .sort((a, b) => a - b);
    const bounds = [0];
    for (const a of interior)
      if (a - bounds[bounds.length - 1] > CORRIDOR_STEP_M) bounds.push(a);
    bounds.push(totals[i]);
    const list: { a1: number; id: number }[] = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      list.push({ a1: bounds[k + 1], id: subs.length });
      subs.push({ piece: i, a0: bounds[k], a1: bounds[k + 1] });
    }
    subsOfPiece.push(list);
  }
  const subAt = (i: number, arc: number): number => {
    for (const s of subsOfPiece[i]) if (arc <= s.a1) return s.id;
    return subsOfPiece[i][subsOfPiece[i].length - 1].id;
  };

  // 6. Union-find sub-pieces that share ground: each surviving matched pair
  //    votes for its (sub_i, sub_j); enough matched length -> same group. A
  //    3-way corridor collapses transitively into one group.
  const parent = subs.map((_, id) => id);
  const find = (x: number): number => {
    if (parent[x] === x) return x;
    parent[x] = find(parent[x]);
    return parent[x];
  };
  const votes = new Map<string, number>();
  for (const { i, j, pairs } of links) {
    for (const { ai, aj } of pairs) {
      const si = subAt(i, ai);
      const sj = subAt(j, aj);
      const key = si < sj ? `${si}|${sj}` : `${sj}|${si}`;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of votes) {
    if (count * CORRIDOR_STEP_M < CORRIDOR_MIN_LINK_M) continue;
    const [a, b] = key.split("|").map(Number);
    parent[find(a)] = find(b);
  }

  // 7. Emit: longest member's polyline represents the group; routes/colors are
  //    the union across members. Singletons pass through (uncut ones verbatim).
  const groups = new Map<number, number[]>();
  subs.forEach((_, id) => {
    const root = find(id);
    (groups.get(root) ?? groups.set(root, []).get(root))?.push(id);
  });

  // Matched-sample separations per merged group, for the report.
  const distsByRoot = new Map<number, number[]>();
  for (const { i, j, pairs } of links) {
    for (const { ai, aj, d } of pairs) {
      const si = subAt(i, ai);
      if (find(si) !== find(subAt(j, aj))) continue;
      const root = find(si);
      (distsByRoot.get(root) ?? distsByRoot.set(root, []).get(root))?.push(d);
    }
  }

  const round1 = (v: number) => Math.round(v * 10) / 10;
  const out: SegmentPiece[] = [];
  const groupReports: MergeGroupReport[] = [];
  for (const [root, members] of groups) {
    const rep = members.reduce((best, id) =>
      subs[id].a1 - subs[id].a0 > subs[best].a1 - subs[best].a0 ? id : best,
    );
    const { piece: pi, a0, a1 } = subs[rep];
    const p = pieces[pi];
    const whole = members.length === 1 && a0 === 0 && a1 === totals[pi];
    const coords = whole
      ? p.coords
      : (lineSliceAlong(lineString(p.coords), a0 / 1000, a1 / 1000, {
          units: "kilometers",
        }).geometry.coordinates as LngLat[]);
    const routes = [
      ...new Set(members.flatMap((id) => pieces[subs[id].piece].routes)),
    ].sort();
    const colors = [
      ...new Set(members.flatMap((id) => pieces[subs[id].piece].colors)),
    ].sort();
    out.push({ routes, colors, direction: p.direction, coords });

    if (members.length < 2) continue;
    const dists = (distsByRoot.get(root) ?? []).sort((a, b) => a - b);
    const midPt = coords[Math.floor(coords.length / 2)];
    groupReports.push({
      routes,
      direction: p.direction,
      colors,
      lengthM: Math.round(a1 - a0),
      mid: [round6(midPt[0]), round6(midPt[1])],
      members: members.map((id) => ({
        routes: pieces[subs[id].piece].routes,
        direction: pieces[subs[id].piece].direction,
        arcM: [Math.round(subs[id].a0), Math.round(subs[id].a1)] as [
          number,
          number,
        ],
      })),
      separationM: {
        min: round1(dists[0] ?? 0),
        p50: round1(dists[Math.floor(dists.length / 2)] ?? 0),
        max: round1(dists[dists.length - 1] ?? 0),
      },
    });
  }
  groupReports.sort((a, b) => b.lengthM - a.lengthM);
  return {
    pieces: out,
    report: {
      piecesIn: pieces.length,
      featuresOut: out.length,
      mergedGroups: groupReports.length,
      groups: groupReports,
    },
  };
}
