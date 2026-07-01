#!/usr/bin/env node
// Query tool for the baked segments.geojson — answers "what's here / how far
// apart / what changed" without ad-hoc scripts. Run via `just inspect`.
//
//   inspect near <lng,lat> [radiusM=800] [--file F]
//       Features with a vertex within radius, longest first.
//
//   inspect sep <selA> <selB> [--near lng,lat[,radiusM]] [--eps 30] [--file F]
//       Distance distribution from selA samples to nearest selB sample within
//       eps. Selector: comma-joined route ids, all required; !R excludes;
//       leading = means exact route set. e.g.  sep '=G' 'A,C,!F'
//
//   inspect diff [--old F] [--file F]
//       Route-combination diff, new vs old. Old defaults to git HEAD's copy.
//
//   inspect lint [--file F]
//       Geometry hygiene: features with consecutive duplicate vertices (these
//       break downstream consumers that need nonzero tangents, e.g. tube
//       renderers), summarized per route combination.
//
//   inspect overlap [--near lng,lat[,radiusM]] [--eps 8] [--minlen 40] [--file F]
//       Pairs of features whose geometry runs coincident (within eps) for at
//       least minlen meters — i.e. two tubes drawn on top of each other. Reports
//       the coincident length per pair, longest first.
//
//   inspect coords <selector> [--near lng,lat[,radiusM]] [--file F]
//       Dump every vertex of each matching feature, with the segment length
//       between consecutive vertices — to see coarse chords and where a tube
//       actually runs. Selector syntax as in `sep`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ASSET_REL = "packages/web/src/assets/segments.geojson";

// --- geo helpers ---
const R = 6_371_000;
const toRad = (d) => (d * Math.PI) / 180;
function hav(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function lengthOf(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += hav(coords[i - 1], coords[i]);
  return d;
}
function densify(coords, step = 10) {
  const out = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const n = Math.max(1, Math.round(hav(a, b) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
const midOf = (f) => {
  const c = f.geometry.coordinates;
  const m = c[Math.floor(c.length / 2)];
  return `${m[0].toFixed(4)},${m[1].toFixed(4)}`;
};
const describe = (f) => {
  const p = f.properties;
  return (
    `${p.routes.join("/").padEnd(16)} (${p.direction}) ` +
    `${Math.round(lengthOf(f.geometry.coordinates)).toString().padStart(5)}m` +
    `  pts=${f.geometry.coordinates.length.toString().padStart(3)}` +
    `  colors=${p.colorCount}  mid=${midOf(f)}`
  );
};

// --- selectors: "A,C,!F" all-of/none-of; "=G,FS" exact set ---
function selector(spec) {
  if (spec.startsWith("=")) {
    const want = spec.slice(1).split(",").sort().join("/");
    return (f) => f.properties.routes.join("/") === want;
  }
  const terms = spec.split(",");
  const need = terms.filter((t) => !t.startsWith("!"));
  const ban = terms.filter((t) => t.startsWith("!")).map((t) => t.slice(1));
  return (f) =>
    need.every((r) => f.properties.routes.includes(r)) &&
    ban.every((r) => !f.properties.routes.includes(r));
}

// --- args ---
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, ...rest] = pos;

function load(file) {
  const p = file ?? path.join(REPO_ROOT, ASSET_REL);
  return JSON.parse(readFileSync(p, "utf8"));
}
function loadOld(file) {
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const out = execFileSync(
    "git",
    ["-C", REPO_ROOT, "show", `HEAD:${ASSET_REL}`],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(out.toString("utf8"));
}
function nearFilter(spec) {
  if (!spec) return () => true;
  const [lng, lat, radius = 800] = spec.split(",").map(Number);
  return (f) => f.geometry.coordinates.some((c) => hav(c, [lng, lat]) < radius);
}

switch (cmd) {
  case "near": {
    const [lng, lat] = rest[0].split(",").map(Number);
    const radius = Number(rest[1] ?? 800);
    const feats = load(flags.file)
      .features.filter((f) =>
        f.geometry.coordinates.some((c) => hav(c, [lng, lat]) < radius),
      )
      .sort(
        (a, b) =>
          lengthOf(b.geometry.coordinates) - lengthOf(a.geometry.coordinates),
      );
    for (const f of feats) console.log(describe(f));
    console.log(`${feats.length} features within ${radius}m of ${lng},${lat}`);
    break;
  }

  case "sep": {
    const [selA, selB] = rest.map(selector);
    const eps = Number(flags.eps ?? 30);
    const circle = nearFilter(flags.near);
    const feats = load(flags.file).features.filter(circle);
    const ptsB = feats
      .filter(selB)
      .flatMap((f) => densify(f.geometry.coordinates));
    // eps-cell hash so whole-network queries stay fast
    const cell = (v) => Math.floor(v / eps);
    const key = (p) => `${cell(p[0] * 85000)}:${cell(p[1] * 111000)}`;
    const grid = new Map();
    for (const p of ptsB) {
      const k = key(p);
      (grid.get(k) ?? grid.set(k, []).get(k)).push(p);
    }
    const dists = [];
    for (const f of feats.filter(selA)) {
      for (const p of densify(f.geometry.coordinates)) {
        const cx = cell(p[0] * 85000);
        const cy = cell(p[1] * 111000);
        let bd = Number.POSITIVE_INFINITY;
        for (let gx = cx - 1; gx <= cx + 1; gx++)
          for (let gy = cy - 1; gy <= cy + 1; gy++)
            for (const q of grid.get(`${gx}:${gy}`) ?? []) {
              const d = hav(p, q);
              if (d < bd) bd = d;
            }
        if (bd < eps) dists.push(bd);
      }
    }
    dists.sort((a, b) => a - b);
    if (dists.length === 0) {
      console.log(`no ${rest[0]} samples within ${eps}m of ${rest[1]}`);
      break;
    }
    const q = (f) => dists[Math.floor(f * (dists.length - 1))].toFixed(1);
    console.log(
      `${rest[0]} vs ${rest[1]}: n=${dists.length} (~${dists.length * 10}m)` +
        `  min=${q(0)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${q(1)}`,
    );
    break;
  }

  case "diff": {
    const oldGeo = loadOld(flags.old);
    const newGeo = load(flags.file);
    const comboKey = (f) => f.properties.routes.join("/");
    const oldSet = new Set(oldGeo.features.map(comboKey));
    const newSet = new Set(newGeo.features.map(comboKey));
    console.log(
      `features: ${oldGeo.features.length} old -> ${newGeo.features.length} new\n`,
    );
    const added = newGeo.features
      .filter((f) => !oldSet.has(comboKey(f)))
      .sort(
        (a, b) =>
          lengthOf(b.geometry.coordinates) - lengthOf(a.geometry.coordinates),
      );
    console.log(`route combinations added (${added.length} features):`);
    for (const f of added) console.log(`  + ${describe(f)}`);
    const removed = [...oldSet].filter((k) => !newSet.has(k));
    console.log(
      `\nroute combinations removed: ${removed.join(", ") || "none"}`,
    );
    break;
  }

  case "lint": {
    const feats = load(flags.file).features;
    const byCombo = new Map();
    let bad = 0;
    for (const f of feats) {
      const c = f.geometry.coordinates;
      let dupes = 0;
      for (let i = 1; i < c.length; i++) {
        if (c[i][0] === c[i - 1][0] && c[i][1] === c[i - 1][1]) dupes++;
      }
      if (dupes === 0) continue;
      bad++;
      const k = f.properties.routes.join("/");
      byCombo.set(k, (byCombo.get(k) ?? 0) + dupes);
    }
    console.log(
      `${bad}/${feats.length} features with consecutive duplicate vertices`,
    );
    const combos = [...byCombo.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of combos) console.log(`  ${k.padEnd(16)} ${n} dupes`);
    break;
  }

  case "overlap": {
    const eps = Number(flags.eps ?? 8);
    const minLen = Number(flags.minlen ?? 40);
    const step = 10;
    const feats = load(flags.file).features.filter(nearFilter(flags.near));
    const samples = feats.map((f) => densify(f.geometry.coordinates, step));

    const cell = (v) => Math.floor(v / eps);
    const key = (p) => `${cell(p[0] * 85000)}:${cell(p[1] * 111000)}`;
    const grid = new Map();
    samples.forEach((pts, fi) => {
      for (const p of pts) {
        const k = key(p);
        (grid.get(k) ?? grid.set(k, []).get(k)).push([p, fi]);
      }
    });

    // For each feature's samples, tally which *other* features run within eps.
    // Each coincident sample ≈ step meters; the pair accumulates from both
    // members' samples, so coincident length ≈ tally · step / 2.
    const pair = new Map();
    samples.forEach((pts, fi) => {
      for (const p of pts) {
        const cx = cell(p[0] * 85000);
        const cy = cell(p[1] * 111000);
        const near = new Set();
        for (let gx = cx - 1; gx <= cx + 1; gx++)
          for (let gy = cy - 1; gy <= cy + 1; gy++)
            for (const [q, fj] of grid.get(`${gx}:${gy}`) ?? []) {
              if (fj !== fi && hav(p, q) < eps) near.add(fj);
            }
        for (const fj of near) {
          const kk = fi < fj ? `${fi}:${fj}` : `${fj}:${fi}`;
          pair.set(kk, (pair.get(kk) ?? 0) + 1);
        }
      }
    });

    const rows = [...pair.entries()]
      .map(([kk, n]) => {
        const [fi, fj] = kk.split(":").map(Number);
        return { fi, fj, len: Math.round((n * step) / 2) };
      })
      .filter((r) => r.len >= minLen)
      .sort((a, b) => b.len - a.len);

    for (const r of rows) {
      const a = feats[r.fi].properties;
      const b = feats[r.fj].properties;
      console.log(
        `${String(r.len).padStart(5)}m  ` +
          `${a.routes.join("/")}(${a.direction})  ≈  ${b.routes.join("/")}(${b.direction})`,
      );
    }
    console.log(
      `${rows.length} overlapping pairs (eps=${eps}m, minlen=${minLen}m)`,
    );
    break;
  }

  case "coords": {
    const sel = selector(rest[0]);
    const feats = load(flags.file)
      .features.filter(nearFilter(flags.near))
      .filter(sel);
    for (const f of feats) {
      console.log(describe(f));
      const c = f.geometry.coordinates;
      for (let i = 0; i < c.length; i++) {
        const seg = i === 0 ? 0 : hav(c[i - 1], c[i]);
        console.log(
          `  ${String(i).padStart(3)}  ${c[i][0].toFixed(5)},${c[i][1].toFixed(5)}` +
            (i === 0 ? "" : `   +${Math.round(seg)}m`),
        );
      }
    }
    console.log(`${feats.length} features`);
    break;
  }

  default:
    console.error(
      "usage: inspect near|sep|diff|lint|overlap|coords  (see header of inspect.mjs)",
    );
    process.exit(1);
}
