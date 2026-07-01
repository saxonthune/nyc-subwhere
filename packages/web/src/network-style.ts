import type maplibregl from "maplibre-gl";

// Tunable presets for the static network rendering (doc02.03/doc02.05), kept in
// one place so the look can be retuned without touching the layer wiring in
// main.ts. Expect these to change often as the visual is refined.
export const NETWORK_STYLE = {
  // Semantic-zoom direction split (doc01.03): perpendicular line offset in pixels
  // by zoom. Both directions coincide (offset 0) until you zoom in past the first
  // stop, then fan apart into parallel tracks. [zoom, offsetPx] pairs.
  directionSplitByZoom: [
    [14, 0],
    [16, 2],
    [17.5, 4],
  ] as [number, number][],

  lineWidth: 1.6,
  glow: { width: 6, blur: 6, opacity: 0.35 },

  // Candy-cane dash patterns (line-width units). dash3a/dash3b phase the 2nd and
  // 3rd colors into thirds (MapLibre has no dash offset, so 3b leads with a
  // near-zero dash to shift it).
  dash2: [2, 2] as number[],
  dash3a: [2, 4] as number[],
  dash3b: [0.01, 2, 2, 2] as number[],

  station: {
    radius: 3,
    color: "#ffffff",
    strokeWidth: 1,
    strokeColor: "#000000",
  },
};

export function directionOffset(): maplibregl.ExpressionSpecification {
  const stops = NETWORK_STYLE.directionSplitByZoom.flat();
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...stops,
  ] as maplibregl.ExpressionSpecification;
}
