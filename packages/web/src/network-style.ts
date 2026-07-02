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
    // Darkened for the Tron base: land reads as a near-black grey plate that the
    // lighting system lifts with a faint cool self-glow (see lighting.land), rather
    // than a flat bright slab washed out by ambient. height sets the cliff depth —
    // with water dropped to lighting.water.level, the exposed face reads tall.
    color: "#2b3138",
    height: 44,
  },
  water: {
    // The near-shore blue. Kept dark enough to stay under the bloom threshold, so
    // water never glows — it only shows as blue hugging the coast (see makeWaterTexture
    // / lighting.water) and drops to black in the open ocean, reading as an abyss.
    color: "#1a4e93",
    // Dropped well below the land's top face (y=0) so the shoreline is a tall cliff
    // and the water sits far below like an abyss. Still above the land's base
    // (-height) so the land stays rooted in the water rather than floating.
    level: -24,
    // The water disc's radius (meters); large enough to reach past every borough.
    radius: 70_000,
    // Shoreline-relative blue (lighting.ts): the blue is keyed to distance from the
    // nearest coast, not the map origin. Water shows blue within `shoreFalloffM` of
    // land and fades to the black background beyond, so the blue hugs every shore and
    // the open ocean reads as an abyss. `shoreIntensity` scales the peak opacity at
    // the waterline; `shoreRes` is the distance-field texture resolution on its long
    // axis (higher = crisper coastline, slower one-time bake at load).
    shoreFalloffM: 2600,
    shoreIntensity: 1.7,
    shoreRes: 1024,
  },

  // ECS-style lighting (lighting.ts): one system owns "how brightly does each role
  // glow" so the concern lives in one place instead of scattered emissive settings.
  // The scene bloom is a single luminance-threshold pass over the whole scene, so the
  // glow tiers fall out of relative brightness: trains (fully self-lit) bloom hardest,
  // track carets and station pucks bloom some, the dim land barely, and the dark water
  // not at all. ambient/key are kept low so the black Tron base stays dark.
  lighting: {
    ambient: 0.28,
    key: 0.45,
    keyDir: [0.5, 1, 0.3] as [number, number, number],
    // Faint cool self-glow on the land so its cliff faces aren't pure black in shade
    // and the plate reads as softly lit from within — a "low glow", below the trains
    // and track.
    land: {
      emissive: "#16222e",
      emissiveIntensity: 0.85,
    },
    // Station pucks as glowing white nodes: a near-white base with a white emissive so
    // they read as bright lit points on the line and bloom a little — less than the
    // trains, more than the land.
    station: {
      color: "#eef3f8",
      emissive: "#ffffff",
      emissiveIntensity: 1.1,
    },
    // Scene bloom (post-process, train-glow.ts BloomGlow). source "scene" blooms the
    // whole scene by luminance so every role tiers naturally; "trains" restricts the
    // bloom source to the train boxes (the older trains-only glow). threshold is the
    // luminance a pixel must clear to bloom — kept low so most route colors glow, but
    // above the dark water and near the dim land so those stay quiet.
    bloom: {
      source: "scene" as "scene" | "trains",
      threshold: 0.12,
      intensity: 1.0,
      radius: 1.5,
      iterations: 4,
    },
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
    // The puck's color/emissive glow is owned by the lighting system
    // (lighting.station); this block keeps only its geometry and zoom behavior.
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
    // Dark plinth: it sits below the network and should recede, not bloom.
    color: "#20242a",
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
    surfaceY: 6,
    wallHeight: 6,
    wallThickness: 1.2,
    wingWidth: 3,
    wingY: 2,
    // Edge light-rail (doc02.05): the floor boundary is extruded into a thin neon
    // piping rather than a grey retaining wall — an emissive strip that blooms under
    // the scene pass, so the ribbon reads as a lit Tron ribbon outlined in light.
    // `edgeColor` is the piping color; `edgeEmissiveIntensity` scales its self-glow
    // (above the bloom threshold so it always glows). Kept a cool near-white so it
    // frames every route color without competing with the floor palette.
    edgeColor: "#dfefff",
    edgeEmissiveIntensity: 1.2,
    // Live trains ride this far to the left of travel — the center of their own
    // direction's half-ribbon (roughly halfWidth/2), so a train sits on its track.
    trainOffsetM: 13,
    // Merge protrusion (doc02.05): after a branch is conformed onto its trunk it is
    // extended to run along the trunk this far, so the junction reads as the branch
    // joining and running parallel rather than crossing and stopping.
    mergeProtrudeM: 35,
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

    // Junction handling (doc02.05). Grade separation is baked as a per-vertex elevation
    // profile in the geometry pipeline (build-graph.ts) and branch tails are conformed
    // onto their trunks (conform-merges.ts). The renderer lifts floor and walls by the
    // profile, fuses each corridor's two directions into one full-width ribbon, and
    // derives walls as the boundary of the assembled floor surface (track-render.ts) —
    // so there are no wall-suppression thresholds left to tune.
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
    // train length). The post-process bloom pass is tuned in lighting.bloom, since it
    // now blooms the whole scene, not just the trains.
    glow: {
      mode: "bloom" as "bloom" | "billboard" | "halo" | "none",
      scaleLength: 1.5,
      scaleCross: 0.6,
      opacity: 0.75,
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
