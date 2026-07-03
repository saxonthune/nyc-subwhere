// Shared geodesic + coordinate helpers for the pipeline stages.

import type { LngLat } from "@nyc-subwhere/contract";

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function haversine(a: LngLat, b: LngLat): number {
  const R = 6_371_000; // meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function cumulative(points: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++)
    out.push(out[i - 1] + haversine(points[i - 1], points[i]));
  return out;
}

// Local equirectangular projection to meters; fine at NYC's extent.
const M_PER_DEG = 111_320;
const NYC_LAT_COS = Math.cos((40.72 * Math.PI) / 180);
export function projectNyc(p: LngLat): [number, number] {
  return [p[0] * M_PER_DEG * NYC_LAT_COS, p[1] * M_PER_DEG];
}
export function unprojectNyc(m: [number, number]): LngLat {
  return [m[0] / (M_PER_DEG * NYC_LAT_COS), m[1] / M_PER_DEG];
}
