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

  // 3D station geometry (doc02.03), rendered in a Three.js custom layer. Sizes are
  // in meters (the layer builds meshes in a meter-scaled local frame). The puck is
  // a flat disc sitting at ground level; the box is a plinth beneath it, revealed
  // only past `boxMinZoom` (semantic-zoom LOD, doc01.03).
  puck: {
    radius: 45,
    // A flat disc barely proud of the tube: height + clearanceOverTube keep its
    // top only just above the tube top (2·tube.radius), so it reads as a point
    // on the line, not a pillar.
    height: 4,
    color: "#ffffff",
    emissive: "#88aaff",
    emissiveIntensity: 0.6,
    // Semantic-zoom fade (doc01.03): fully opaque at/below fadeStartZoom, fully
    // gone at/above fadeEndZoom, so close in the tubes pass over the platform box
    // with no puck occluding them.
    fadeStartZoom: 15.5,
    fadeEndZoom: 17,
    // Seated so the puck top clears the tube top by this much, reading as a point
    // on the line when zoomed out.
    clearanceOverTube: 1,
  },
  box: {
    // Rectangular platform: length runs along the track, width across it.
    length: 90,
    width: 46,
    depth: 30,
    color: "#3a3a3a",
    minZoom: 15,
  },

  // 3D route tubes (doc02.03). Radius/segments in meters; the tube centerline
  // rides at y=radius so its underside sits on the ground plane, above the
  // platform boxes. emissive carries the tron glow (colored per Route).
  tube: {
    radius: 11,
    radialSegments: 6,
    emissiveIntensity: 0.5,
    // Every tube shifts this many meters to the left of its own travel direction.
    // N and S shapes run antiparallel along the same alignment, so an equal shift
    // pushes them to opposite sides — parallel tracks (doc01.03) instead of two
    // tubes fighting on one centerline. ~radius apart leaves a clean gap.
    sideOffsetM: 13,
    // Candy-cane banding for multi-color trunks: each color paints one
    // arc-length band along the tube, cycling through the trunk's colors. The
    // band boundary is cut on a slant (advanced on one flank, retreated on the
    // other) so a chunk reads like a penne noodle, not a flat cylinder ring.
    candy: {
      bandLengthM: 45,
      slantM: 22,
    },
  },

  // Live trains (doc01.03): a single elongated box per Trip, length along the
  // track. Meters. The train sits on top of the tubes and pucks — its underside
  // rests `clearance` above the puck top (the layer computes centerY from the
  // tube/puck heights). Colored per Route with an emissive tron glow like the tubes.
  train: {
    length: 70,
    width: 16,
    height: 10,
    clearance: 2,
    // Additive glow shell (cheap fake bloom): a larger translucent box around the
    // core, scaled more across the track than along it, so the halo reads as a
    // soft aura lifting the train off the line below.
    glow: {
      scaleLength: 1.15,
      scaleCross: 2.2,
      opacity: 0.4,
    },
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
