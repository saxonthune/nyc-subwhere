#!/usr/bin/env node
// Summarize the prediction-error metric (doc02.04) captured by the dev file sink
// at packages/web/.metrics/prediction-error.jsonl. Reports the per-poll series,
// the pooled jump distribution across every scored train, and the pathological
// tail (terminal turnarounds and line switches that snap a full track length and
// distort the mean). Run via `just metrics-report`. The re-anchor jump is the
// visible teleport when a fresher frame lands; these numbers are the before/after
// yardstick for any interpolation or worker fix.

import { readFileSync } from "node:fs";
import path from "node:path";

const OUTLIER_M = 2000; // above this, a "jump" is a turnaround/reassignment, not motion error

// Defaults to the live sink; pass a path (e.g. a saved baseline) to report on it.
const file = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, "../.metrics/prediction-error.jsonl");

let recs;
try {
  recs = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch {
  console.error(`no metrics at ${file} — run the app (just dev-all) first`);
  process.exit(1);
}
if (!recs.length) {
  console.error("metrics file is empty");
  process.exit(1);
}

const pct = (xs, q) =>
  xs.length ? xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)] : 0;
const r1 = (x) => Math.round(x * 10) / 10;

console.log(`records: ${recs.length}\n`);
console.log("per-poll  matched  p50   p95   max     bias   worst-route");
for (const r of recs) {
  const worst = Object.entries(r.byRoute).sort(
    (a, b) => b[1].mean - a[1].mean,
  )[0];
  const w = worst ? `${worst[0]} (${worst[1].mean})` : "-";
  console.log(
    `          ${String(r.counts.matched).padStart(5)}  ${String(r.meters.p50).padStart(5)} ${String(r.meters.p95).padStart(5)} ${String(r.meters.max).padStart(6)}  ${String(r.meters.meanSigned).padStart(6)}  ${w}`,
  );
}

// Pool every per-trip row across all polls for the honest distribution.
const all = recs.flatMap((r) => r.trips);
const absAll = all.map((t) => Math.abs(t.err)).sort((a, b) => a - b);
const clean = all
  .map((t) => Math.abs(t.err))
  .filter((e) => e < OUTLIER_M)
  .sort((a, b) => a - b);
const outliers = all.filter((t) => Math.abs(t.err) >= OUTLIER_M);
const signed = all.map((t) => t.err);
const meanSigned = signed.reduce((a, b) => a + b, 0) / signed.length;

console.log(`\npooled over ${all.length} scored trains, ${recs.length} polls`);
console.log(
  `  all:              p50=${r1(pct(absAll, 0.5))} p95=${r1(pct(absAll, 0.95))} max=${r1(pct(absAll, 1))}`,
);
console.log(
  `  excl |err|>${OUTLIER_M}m:  p50=${r1(pct(clean, 0.5))} p95=${r1(pct(clean, 0.95))} max=${r1(pct(clean, 1))}  (n=${clean.length})`,
);
console.log(
  `  signed bias:      ${r1(meanSigned)} m  (${meanSigned < 0 ? "rendered AHEAD of fresh obs — over-glides" : "rendered BEHIND fresh obs"})`,
);
console.log(
  `  outliers >${OUTLIER_M}m:   ${outliers.length} (${r1((100 * outliers.length) / all.length)}%) — turnarounds/reassignments`,
);

// Position-Honesty violations (doc01.03): trains the prior frame rendered PAST a
// Station the fresh frame shows they had not reached. This is the metric a fix
// must drive to zero — the signed bias above is the "how far ahead", this is the
// "how often we crossed a platform we shouldn't have".
// Exclude the turnaround/reassignment outliers: a trip snapping a full track
// length trivially crosses every Station and would swamp the honest signal.
const overshot = all.filter(
  (t) => t.overshotStations != null && Math.abs(t.err) < OUTLIER_M,
);
if (overshot.length) {
  const violations = overshot.filter((t) => t.overshotStations > 0);
  const stations = overshot.reduce((a, t) => a + t.overshotStations, 0);
  const worst = Math.max(...overshot.map((t) => t.overshotStations));
  console.log(
    `  station overshoot: ${violations.length}/${overshot.length} trains (${r1((100 * violations.length) / overshot.length)}%) crossed an unreached Station — ${stations} false passages, worst ${worst} stations in one poll`,
  );
} else {
  console.log(
    "  station overshoot: (not in these records — recapture to populate)",
  );
}

// Worst routes, pooled. `signed` (mean err) shows the DIRECTION each line errs:
// negative = rendered ahead of the fresh observation (the honesty-risky way).
const byRoute = new Map();
for (const t of all) {
  if (Math.abs(t.err) >= OUTLIER_M) continue;
  const g = byRoute.get(t.routeId) ?? [];
  g.push(t.err);
  byRoute.set(t.routeId, g);
}
const ranked = [...byRoute.entries()]
  .map(([route, v]) => [
    route,
    v.reduce((a, b) => a + Math.abs(b), 0) / v.length,
    v.reduce((a, b) => a + b, 0) / v.length,
    v.length,
  ])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
console.log("\nworst routes (mean |err| m / signed, excl outliers):");
for (const [route, mean, signed, n] of ranked) {
  console.log(
    `  ${route.padEnd(3)} ${r1(mean).toString().padStart(6)}  signed ${r1(signed).toString().padStart(7)}  n=${n}`,
  );
}
