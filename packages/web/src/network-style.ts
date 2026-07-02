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

  // Basemap (doc01.03 Basemap): the five boroughs as grey extruded land over a flat
  // dark-navy water plane, both drawn beneath the network. Meters. Land is extruded
  // downward from ground level (y=0) so its top face is the ground the tubes ride on;
  // water is a single plane seated below that top so the boroughs poke above it and
  // everything outside them reads as water.
  land: {
    color: "#454b52",
    height: 40,
  },
  water: {
    color: "#0a1a35",
    // Below the land's top face (y=0) but above its base (-height), so land stands
    // out of the water at a shoreline.
    level: -8,
    // A disc rather than a square: its solid navy core spans well past the five
    // boroughs, then a radial gradient fades it to transparent by the rim so the
    // water dissolves into the black background with no hard edge. Meters.
    radius: 70_000,
    coreFraction: 0.5,
  },

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

  // 3D route track (doc02.03), one wide flat ribbon built by the swappable
  // TrackRenderer (track-render.ts). All meters. A corridor's two directions each
  // draw as a half-ribbon offset to its own left, tiling one floor `halfWidth` from
  // the center on each side, at height `surfaceY`. `medianGap` is a thin seam kept
  // clear at the centerline. A grey wall of `wallThickness`×`wallHeight` stands on
  // each outer edge only (none down the median), with a wing flanging `wingWidth`
  // out past it at `wingY`. Expect these to change often as the look is tuned.
  track: {
    halfWidth: 26,
    medianGap: 0,
    surfaceY: 2,
    wallHeight: 8,
    wallThickness: 2,
    wingWidth: 3,
    wingY: 2,
    greyColor: "#9098a0",
    // Live trains ride this far to the left of travel — the center of their own
    // direction's half-ribbon (roughly halfWidth/2), so a train sits on its track.
    trainOffsetM: 13,
    // Caret marks on the floor (doc01.03): the ribbon is partitioned into chevron
    // cells by one bent coordinate `g = along + |across|·tan(bendDeg)`; each cell is
    // one palette color and the black caret line sits exactly on the cell boundary,
    // so color and mark are registered by construction. spacingM: base along-track
    // cell period; bendDeg: arm angle up from the cross-track line; lineM: caret line
    // half-width (meters).
    //
    // LOD (doc01.03), to keep the pattern legible across zoom rather than aliasing
    // when small: minCellPx floors the cell period at this many screen pixels when
    // zoomed out (bands coarsen but never fall sub-pixel and shimmer, and a shared
    // trunk still shows every color); carets fade from absent below fadeStartZoom to
    // full at fadeEndZoom, so far out the floor reads as clean color stripes.
    chevron: {
      spacingM: 16,
      bendDeg: 30,
      lineM: 1.4,
      minCellPx: 8,
      fadeStartZoom: 13,
      fadeEndZoom: 14.5,
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
    // Train glow is a swappable effect (train-glow.ts). `mode` picks the technique:
    //   "bloom"     — real post-process bloom of the bright train boxes.
    //   "billboard" — camera-facing additive sprite over each train (no clipping).
    //   "halo"      — the sprite behind the box, so only a backlit rim shows.
    //   "none"      — no glow.
    // scaleLength/scaleCross/opacity size the billboard/halo sprite (multiples of
    // train length); bloom.* tune the post-process pass.
    glow: {
      mode: "bloom" as "bloom" | "billboard" | "halo" | "none",
      scaleLength: 1.5,
      scaleCross: 0.6,
      opacity: 0.75,
      bloom: {
        // Luminance above which a pixel blooms. The bloom source is trains-only,
        // so this only needs to drop the black background; keep it low so every
        // Route color (even the darker reds/greens) blooms.
        threshold: 0.1,
        // Additive strength of the composited bloom.
        intensity: 1.2,
        // Blur step in half-res texels per tap; larger = wider, softer halo.
        radius: 1.5,
        // Horizontal+vertical blur passes; more = smoother, wider bloom.
        iterations: 4,
      },
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
