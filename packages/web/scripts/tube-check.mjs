#!/usr/bin/env node
// Renderability check for the baked segments: replicate the NetworkLayer tube
// build end to end — dedupe → CatmullRomCurve3 → TubeGeometry → candy-cane
// banding → per-color mergeGeometries — and flag anything that would render as
// nothing. Two failure modes blank geometry on the map:
//   - a NaN vertex poisons a merged mesh's bounding sphere, so three.js
//     frustum-culls the whole color bucket;
//   - mergeGeometries() returns null when a bucket mixes incompatible attributes,
//     dropping that color entirely.
// One bad segment can therefore blank a whole color across the map. Run via
// `just tube-check`.
//
// Lives in packages/web (not geometry) so `import "three"` resolves the web
// package's own copy; the meter projection here need only preserve collinearity,
// which is all the Frenet-frame degeneracy that produces NaN depends on.

import { readFileSync } from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const RADIUS = 11;
const RADIAL_SEGMENTS = 6;
const CANDY = { bandLengthM: 45, slantM: 22 };

const file = path.resolve(
  import.meta.dirname,
  "../src/assets/segments.geojson",
);
const geo = JSON.parse(readFileSync(file, "utf8"));

const ref = [-73.98, 40.75];
const mPerDegLat = 111_320;
const mPerDegLng = 111_320 * Math.cos((ref[1] * Math.PI) / 180);
const toLocal = ([lng, lat]) => [
  (lng - ref[0]) * mPerDegLng,
  (lat - ref[1]) * mPerDegLat,
];

function dedupeConsecutive(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

function bandTube(g, length, tubular, colors) {
  const ring = RADIAL_SEGMENTS + 1;
  const ringSpacing = length / tubular;
  const bandRings = Math.max(1, CANDY.bandLengthM / ringSpacing);
  const slantRings = CANDY.slantM / ringSpacing;
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const index = g.getIndex();
  if (!index) return [];
  const sOf = (idx) => {
    const i = Math.floor(idx / ring);
    const j = idx % ring;
    return i + slantRings * Math.cos((2 * Math.PI * j) / RADIAL_SEGMENTS);
  };
  const buckets = new Map();
  const arr = index.array;
  for (let t = 0; t < arr.length; t += 3) {
    const tri = [arr[t], arr[t + 1], arr[t + 2]];
    const s = (sOf(tri[0]) + sOf(tri[1]) + sOf(tri[2])) / 3;
    const n = colors.length;
    const color = colors[((Math.floor(s / bandRings) % n) + n) % n];
    let bucket = buckets.get(color);
    if (!bucket) {
      bucket = { p: [], n: [] };
      buckets.set(color, bucket);
    }
    for (const idx of tri) {
      bucket.p.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
      bucket.n.push(nor.getX(idx), nor.getY(idx), nor.getZ(idx));
    }
  }
  const out = [];
  for (const [color, { p, n }] of buckets) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    bg.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
    out.push([color, bg]);
  }
  return out;
}

const byColor = new Map();
const push = (color, g) => {
  const bucket = byColor.get(color);
  if (bucket) bucket.push(g);
  else byColor.set(color, [g]);
};

let empty = 0;
for (const f of geo.features) {
  const colors = f.properties.colors ?? [f.properties.color0];
  const pts = dedupeConsecutive(f.geometry.coordinates)
    .map(toLocal)
    .map(([x, z]) => new THREE.Vector3(x, RADIUS, z));
  if (pts.length < 2) {
    empty++;
    continue;
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const tubular = Math.min(400, Math.max(4, pts.length));
  const g = new THREE.TubeGeometry(
    curve,
    tubular,
    RADIUS,
    RADIAL_SEGMENTS,
    false,
  );
  if (colors.length <= 1) {
    g.deleteAttribute("uv");
    push(colors[0] ?? "#ffffff", g.toNonIndexed());
    g.dispose();
    continue;
  }
  for (const [color, sub] of bandTube(g, curve.getLength(), tubular, colors)) {
    push(color, sub);
  }
  g.dispose();
}

console.log(`empty(<2pts)=${empty}  colors=${byColor.size}\n`);
let failures = 0;
for (const [color, geos] of [...byColor].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  const merged = mergeGeometries(geos, false);
  let status = "ok";
  if (!merged) {
    status = "MERGE FAILED (null)";
    failures++;
  } else {
    const pos = merged.getAttribute("position").array;
    let nan = false;
    for (let i = 0; i < pos.length; i++)
      if (Number.isNaN(pos[i])) {
        nan = true;
        break;
      }
    if (nan) {
      status = "NaN vertices";
      failures++;
    } else if (pos.length === 0) {
      status = "EMPTY";
      failures++;
    }
  }
  console.log(`  ${color}  ${String(geos.length).padStart(4)} geos  ${status}`);
}
console.log(`\n${failures} failing color bucket(s)`);
