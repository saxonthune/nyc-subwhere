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
// Broadway ~9 m), and a shallow crossing's separation is V-shaped — near 0 at
// the crossing, ε at the run's ends — so its median lands around ε/2 ≈ 15 m.
// Alignments that truly coincide (Hoyt, CPW, QBL, J/M/Z) all measure ≤ ~5 m.
const CORRIDOR_MAX_MEDIAN_SEP_M = 6;
// Exception for one very long codirectional run: the Manhattan Bridge carries
// B/D and N/Q on its two sides ~22 m apart for ~2.7 km — the only place two
// distinct alignments run parallel this far. The map wants them read as one
// ribbon per direction (they are drawn as a stacked double otherwise), so a run
// this long is allowed a wider median. Nothing else in the network runs parallel
// past ~300 m, so the length gate admits only the bridge.
const CORRIDOR_LONG_OVERLAP_M = 800;
const CORRIDOR_LONG_MAX_SEP_M = 25;
// When choosing which of a group's coincident members to draw, a member counts
// as redundant if this fraction of it is covered by others — high enough that a
// genuine unique tail survives, low enough to absorb cut-rounding at the ends.
const CORRIDOR_COVER_FRAC = 0.9;

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
        const overlap = a1 - a0;
        if (overlap < CORRIDOR_MIN_OVERLAP_M) return;
        const ds = pairs.map((p) => p.d).sort((x, y) => x - y);
        const maxSep =
          overlap >= CORRIDOR_LONG_OVERLAP_M
            ? CORRIDOR_LONG_MAX_SEP_M
            : CORRIDOR_MAX_MEDIAN_SEP_M;
        if (ds[Math.floor(ds.length / 2)] > maxSep) return;
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

  // 7. Emit: keep the member polylines that preserve the group's detail; their
  //    routes/colors are the union across all members. A group's members all
  //    trace the same shared ground, so emitting one representative used to pick
  //    the longest — which silently dropped finer geometry when a coarse chord
  //    (e.g. an express shape skipping a local stop) spanned two local hops that
  //    carry the intermediate station, orphaning it. Instead, drop coarsest-first
  //    any member whose ground the others still cover: co-extensive duplicates
  //    collapse to one (the stripe case), but a spanning chord yields to the finer
  //    hops it subdivides. Singletons pass through (uncut ones verbatim).
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

  const memberCoords = (id: number): LngLat[] => {
    const { piece: pi, a0, a1 } = subs[id];
    const p = pieces[pi];
    return a0 === 0 && a1 === totals[pi]
      ? p.coords
      : (lineSliceAlong(lineString(p.coords), a0 / 1000, a1 / 1000, {
          units: "kilometers",
        }).geometry.coordinates as LngLat[]);
  };
  // Even samples of a polyline in projected meters, for the coverage test.
  const sampleCoords = (coords: LngLat[]): [number, number][] => {
    const proj = coords.map(projectNyc);
    const out: [number, number][] = [];
    for (let k = 0; k < proj.length - 1; k++) {
      const [ax, ay] = proj[k];
      const [bx, by] = proj[k + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const n = Math.max(1, Math.round(Math.hypot(dx, dy) / CORRIDOR_STEP_M));
      for (let s = 0; s < n; s++) {
        const t = s / n;
        out.push([ax + dx * t, ay + dy * t]);
      }
    }
    const last = proj[proj.length - 1];
    if (last) out.push([last[0], last[1]]);
    return out;
  };
  // Fraction of m's samples within ε of some sample among others.
  const coverFrac = (
    m: [number, number][],
    others: [number, number][][],
  ): number => {
    if (m.length === 0) return 1;
    const g = new Map<string, [number, number][]>();
    for (const set of others)
      for (const q of set) {
        const key = `${cell(q[0])}:${cell(q[1])}`;
        (g.get(key) ?? g.set(key, []).get(key))?.push(q);
      }
    let covered = 0;
    for (const p of m) {
      const cx = cell(p[0]);
      const cy = cell(p[1]);
      let hit = false;
      for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++)
        for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++)
          for (const q of g.get(`${gx}:${gy}`) ?? []) {
            if (
              (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 <=
              CORRIDOR_EPS_M ** 2
            ) {
              hit = true;
              break;
            }
          }
      if (hit) covered++;
    }
    return covered / m.length;
  };

  const out: SegmentPiece[] = [];
  const groupReports: MergeGroupReport[] = [];
  for (const [root, members] of groups) {
    const routes = [
      ...new Set(members.flatMap((id) => pieces[subs[id].piece].routes)),
    ].sort();
    const colors = [
      ...new Set(members.flatMap((id) => pieces[subs[id].piece].colors)),
    ].sort();

    const coordsOf = new Map<number, LngLat[]>();
    const samplesOf = new Map<number, [number, number][]>();
    for (const id of members) {
      const c = memberCoords(id);
      coordsOf.set(id, c);
      samplesOf.set(id, sampleCoords(c));
    }
    const samplesFor = (id: number) => samplesOf.get(id) as [number, number][];
    const arcLen = (id: number) => subs[id].a1 - subs[id].a0;
    const density = (id: number) =>
      (coordsOf.get(id)?.length ?? 0) / Math.max(1, arcLen(id));

    // Phase A — collapse members that trace the same run to one. Two members
    // that mutually cover each other are the same shared ground drawn twice (the
    // stripe case: the G sub and the A/C sub over Hoyt), differing only by cut
    // rounding at the ends. Keep the longest; a later equivalent is dropped.
    const reps: number[] = [];
    const byLongest = [...members].sort(
      (a, b) => arcLen(b) - arcLen(a) || density(b) - density(a),
    );
    for (const id of byLongest) {
      const dup = reps.some(
        (r) =>
          coverFrac(samplesFor(id), [samplesFor(r)]) >= CORRIDOR_COVER_FRAC &&
          coverFrac(samplesFor(r), [samplesFor(id)]) >= CORRIDOR_COVER_FRAC,
      );
      if (!dup) reps.push(id);
    }

    // Phase B — drop a rep whose ground the *union* of the others still covers,
    // even though no single other does: a coarse chord spanning several finer
    // hops (an express shape skipping a local stop) yields to those hops so their
    // intermediate station keeps its geometry. Coarsest-first so the chord goes,
    // not the detail.
    const kept = new Set(reps);
    for (const id of [...reps].sort((a, b) => density(a) - density(b))) {
      if (kept.size <= 1) break;
      const others = [...kept].filter((x) => x !== id).map(samplesFor);
      if (coverFrac(samplesFor(id), others) >= CORRIDOR_COVER_FRAC)
        kept.delete(id);
    }

    for (const id of kept)
      out.push({
        routes,
        colors,
        direction: pieces[subs[id].piece].direction,
        coords: coordsOf.get(id) as LngLat[],
      });

    if (members.length < 2) continue;
    const dists = (distsByRoot.get(root) ?? []).sort((a, b) => a - b);
    const repId = [...kept].reduce((best, id) =>
      subs[id].a1 - subs[id].a0 > subs[best].a1 - subs[best].a0 ? id : best,
    );
    const repCoords = coordsOf.get(repId) as LngLat[];
    const midPt = repCoords[Math.floor(repCoords.length / 2)];
    groupReports.push({
      routes,
      direction: pieces[subs[repId].piece].direction,
      colors,
      lengthM: Math.round(subs[repId].a1 - subs[repId].a0),
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
