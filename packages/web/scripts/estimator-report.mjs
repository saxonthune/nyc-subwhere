#!/usr/bin/env node
// Summarize the estimator metric (doc02.06) captured by the dev file sink at
// packages/web/.metrics/estimator.jsonl. Two questions, side by side:
//   * estimate vs reality — how far the RENDERED position had drifted from the
//     fresh observation when each poll landed (signed: + = rendered ahead of
//     reality, the honesty-risky way);
//   * visual jump — how much a train actually teleported when the estimate
//     re-based, i.e. what the rider sees. Continuity makes most of these ~0; the
//     survivors are the honest corrections (forward snap on an observed pass,
//     pull-back off an over-glide).
// Run via `just estimator-report`. Pass a path to report on a saved capture.

import { readFileSync } from "node:fs";
import path from "node:path";

const OUTLIER_M = 2000; // turnaround/reassignment, not motion — kept out of the pooled stats

const file = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, "../.metrics/estimator.jsonl");

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
const sign = (v) => (v >= 0 ? `+${r1(v)}` : `${r1(v)}`);

console.log(`records: ${recs.length}\n`);
console.log(
  "per-poll  matched  drift-p50  drift-bias  jump-p50  jump-max  teleported",
);
for (const r of recs) {
  console.log(
    `          ${String(r.matched).padStart(5)}  ${String(r.drift.p50).padStart(9)}  ${sign(r.drift.signed).padStart(10)}  ${String(r.jump.p50).padStart(8)}  ${String(r.jump.max).padStart(8)}  ${r.jump.moved}/${r.matched}`,
  );
}

// Pool every reconciled trip across all polls.
const all = recs.flatMap((r) => r.trips);
const drift = all.map((t) => t.drift).filter((d) => Math.abs(d) < OUTLIER_M);
const jump = all.map((t) => t.jump).filter((d) => Math.abs(d) < OUTLIER_M);
const driftAbs = drift.map(Math.abs).sort((a, b) => a - b);
const jumpAbs = jump.map(Math.abs).sort((a, b) => a - b);
const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const moved = jump.filter((d) => Math.abs(d) > 1).length;

console.log(
  `\npooled over ${all.length} reconciled trains, ${recs.length} polls (excl |·|>${OUTLIER_M}m)`,
);
console.log(
  "  estimate vs reality — how far the render sits from the fresh observation:",
);
console.log(
  `    p50=${r1(pct(driftAbs, 0.5))} p95=${r1(pct(driftAbs, 0.95))}  bias=${sign(mean(drift))} m  (${mean(drift) < 0 ? "render BEHIND reality — honest side" : "render AHEAD of reality"})`,
);
console.log(
  "  visual jump — how far trains teleport when the estimate re-bases:",
);
console.log(
  `    p50=${r1(pct(jumpAbs, 0.5))} p95=${r1(pct(jumpAbs, 0.95))} max=${r1(pct(jumpAbs, 1))}  bias=${sign(mean(jump))} m`,
);
console.log(
  `    teleported >1m: ${moved}/${jump.length} (${r1((100 * moved) / (jump.length || 1))}%)`,
);

// Worst routes by drift (rendered-vs-reality), signed so direction is visible.
const byRoute = new Map();
for (const t of all) {
  if (Math.abs(t.drift) >= OUTLIER_M) continue;
  const g = byRoute.get(t.routeId) ?? [];
  g.push(t.drift);
  byRoute.set(t.routeId, g);
}
const ranked = [...byRoute.entries()]
  .map(([route, v]) => [route, mean(v.map(Math.abs)), mean(v), v.length])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
console.log("\nworst routes (mean |drift| m / signed vs reality):");
for (const [route, m, signed, n] of ranked) {
  console.log(
    `  ${route.padEnd(3)} ${r1(m).toString().padStart(6)}  signed ${sign(signed).padStart(7)}  n=${n}`,
  );
}
