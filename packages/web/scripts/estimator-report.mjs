#!/usr/bin/env node
// Summarize the estimator metric (doc02.06) captured by the dev file sink at
// packages/web/.metrics/estimator.jsonl. Reports, pooled across polls:
//   * over-glide vs OBSERVED passes — the honesty signal: at a real station pass,
//     how far off the render was. Anchored on a hard fact; negative = behind the
//     platform (honest), positive = rendered past it (violation);
//   * visual jump — how far a train teleported when the estimate re-based (what the
//     rider sees); continuity keeps most ~0;
//   * speed jitter — the step in glide speed at a re-base, split into pure-slope
//     (a lurch with no position reason) vs riding a position snap;
//   * blink/hold rate — fraction of trains held short of their station;
//   * vs FEED extrapolation — a secondary, OPTIMISTIC reference, not ground truth.
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

// Blink/hold pressure: fraction of live trains held short of their station at poll
// time. The cost side of trading behind-ness for a pace lead (older records lack
// the fields → guarded).
const withBlink = recs.filter((r) => r.live != null && r.blinking != null);
if (withBlink.length) {
  const live = withBlink.reduce((a, r) => a + r.live, 0);
  const blink = withBlink.reduce((a, r) => a + r.blinking, 0);
  console.log(
    `  blink/hold at poll time: ${blink}/${live} live trains (${r1((100 * blink) / (live || 1))}%)`,
  );
}
console.log(
  "  vs FEED extrapolation (an OPTIMISTIC reference, not ground truth — see observed-pass line):",
);
console.log(
  `    p50=${r1(pct(driftAbs, 0.5))} p95=${r1(pct(driftAbs, 0.95))}  bias=${sign(mean(drift))} m  (${mean(drift) < 0 ? "behind the feed's extrapolation" : "ahead of the feed's extrapolation"})`,
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

// Speed jitter: the step in rendered glide speed at each re-base. Position is
// continuous, but a big slope step is a perceived lurch — the smoothness axis the
// jump metric misses.
const spdAll = all.filter((t) => t.speedDelta != null);
if (spdAll.length) {
  const line = (rows) => {
    const xs = rows.map((t) => Math.abs(t.speedDelta)).sort((a, b) => a - b);
    return `p50=${r1(pct(xs, 0.5))} p95=${r1(pct(xs, 0.95))} mean=${r1(mean(xs))}  n=${xs.length}`;
  };
  // Pure-slope jitter (no position jump) is the honest lurch-without-reason: a
  // speed step while the train glided smoothly in position. Jitter that rides a
  // position snap is an expected part of an observed-pass correction.
  const pure = spdAll.filter((t) => Math.abs(t.jump) < 1);
  const snap = spdAll.filter((t) => Math.abs(t.jump) >= 1);
  console.log("  speed jitter — step in glide speed at re-base (m/s):");
  console.log(`    all:                    ${line(spdAll)}`);
  console.log(`    pure slope (no jump):   ${line(pure)}`);
  console.log(`    with a position snap:   ${line(snap)}`);
} else {
  console.log("  speed jitter: (not in these records — recapture to populate)");
}

// Ground-truth over-glide: scored only on trains observed passing a station, so
// it's anchored on a hard fact rather than the feed's optimistic extrapolation.
const pass = all
  .map((t) => t.passOverglide)
  .filter((p) => p != null && Math.abs(p) < OUTLIER_M);
if (pass.length) {
  const passAbs = pass.map(Math.abs).sort((a, b) => a - b);
  console.log(
    "  over-glide vs OBSERVED passes — where we'd rendered the train when it truly passed a station:",
  );
  console.log(
    `    p50=${r1(pct(passAbs, 0.5))} p95=${r1(pct(passAbs, 0.95))}  bias=${sign(mean(pass))} m  (${mean(pass) < 0 ? "behind the platform — honest" : "already PAST the platform — real over-glide"}), n=${pass.length}`,
  );
} else {
  console.log(
    "  over-glide vs OBSERVED passes: (not in these records — recapture to populate)",
  );
}

// Worst routes by GROUND-TRUTH over-glide (observed passes only), signed so
// direction shows: + = rendered past the platform (over-glide), − = behind it.
// This is the honest per-route signal; drift-vs-feed above is a biased reference.
// Routes with < 5 observed passes are dropped to avoid single-sample noise.
const byRoute = new Map();
for (const t of all) {
  if (t.passOverglide == null || Math.abs(t.passOverglide) >= OUTLIER_M)
    continue;
  const g = byRoute.get(t.routeId) ?? [];
  g.push(t.passOverglide);
  byRoute.set(t.routeId, g);
}
const ranked = [...byRoute.entries()]
  .map(([route, v]) => [route, mean(v.map(Math.abs)), mean(v), v.length])
  .filter(([, , , n]) => n >= 5)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
console.log(
  "\nworst routes (mean |over-glide| m / signed vs OBSERVED passes; + = past platform):",
);
for (const [route, m, signed, n] of ranked) {
  console.log(
    `  ${route.padEnd(3)} ${r1(m).toString().padStart(6)}  signed ${sign(signed).padStart(7)}  n=${n}`,
  );
}
