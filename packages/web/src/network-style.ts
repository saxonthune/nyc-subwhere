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
    height: 100,
  },
  water: {
    // The near-shore blue. Kept dark enough to stay under the bloom threshold, so
    // water never glows — it only shows as blue hugging the coast (see makeWaterTexture
    // / lighting.water) and drops to black in the open ocean, reading as an abyss.
    color: "#1a4e93",
    // Dropped well below the land's top face (y=0) so the shoreline is a tall cliff
    // and the water sits far below like an abyss. Still above the land's base
    // (-height) so the land stays rooted in the water rather than floating.
    level: -60,
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

  // Bike View (doc01.04): the subway receded to context — centerlines as skinny
  // tubes, small pucks, trains as small discs. Meters. The ribbon width itself is
  // baked (build-ribbons.ts HALF_WIDTH_M), so Bike View swaps representation
  // rather than narrowing it.
  bikeView: {
    lineRadius: 3,
    // The receded subway's colors (thin network, station squares, trains) are
    // all scaled by this before drawing, sinking them mostly under the bloom
    // threshold so the network glows only faintly next to the docks.
    networkDim: 0.55,
    // Square markers, not discs: side sits slightly under the old disc
    // diameter (24 and 18) so the swap doesn't grow the footprint. The train
    // square orients along travel via the pose loop's bearing rotation.
    // `dim` scales the square's color on top of networkDim: at bare networkDim
    // the near-white still cleared the bloom threshold and glowed harshly.
    station: { side: 20, height: 8, dim: 0.5 },
    // Manhattan avenue bearing (degrees east of north). Station squares rotate
    // so their corners point along the grid — one shared orientation citywide,
    // so off-grid boroughs wear it too.
    gridBearingDeg: 29,
    train: { side: 16, height: 4 },
    // Citi Bike docks: plain white discs, a step bigger than the receded subway
    // stations so they read as the view's subject. Low profile (half the old
    // height), and they share the trains' cel outline pass (network-layer.ts).
    // `marker` picks the representation: "disc" is the bare white puck;
    // "scoreboard" replaces it with a flat per-dock count board
    // (bike-scoreboard.ts) that yaws with the camera; "gauge" keeps the disc
    // as a white base and raises a radial availability gauge out of its top
    // face (bike-disc-gauge.ts), world-aligned to the Manhattan grid. The disc
    // mesh stays in every mode as the pick proxy.
    bikeStation: {
      radius: 20,
      height: 4,
      color: "#ffffff",
      marker: "gauge" as "disc" | "scoreboard" | "gauge",
      // Slab meters; colors match the dock modal's resource palette, plus the
      // warning red a zero count renders in.
      scoreboard: {
        width: 64,
        depth: 28,
        thickness: 4,
        background: "#0d1117",
        side: "#161c24",
        colors: {
          classic: "#22d3ee",
          ebikes: "#ff5fd2",
          docks: "#aab4bf",
          zero: "#ff2d2d",
        },
      },
      // Disc gauge: the white disc top divides into one sector per resource,
      // each filling outward in rings as stock crosses its thresholds — real
      // extruded pieces bulging slightly out of the disc (bike-disc-gauge.ts),
      // drawn in their own pass over the bloom so the disc's white glow never
      // washes them. All layout is data so sectors, rings, thresholds, and
      // colors retune here alone.
      gauge: {
        // centerDeg is the compass bearing of the sector's center before the
        // grid rotation (0 = north/top, clockwise); spanDeg is the sector's
        // full angular share — the white channel between sectors is carved out
        // of it by sectorGapFrac below. ringThresholds is per sector, inner
        // ring first: ring i lights when the count reaches [i] — append an
        // entry to give a sector another ring. The docks grey is a shade
        // darker than the modal's: it sits on white here, not on the dark
        // panel.
        slices: [
          {
            key: "classicBikes" as const,
            color: "#22d3ee",
            centerDeg: 300,
            spanDeg: 120,
            ringThresholds: [1, 4],
          },
          {
            key: "ebikes" as const,
            color: "#ff5fd2",
            centerDeg: 60,
            spanDeg: 120,
            ringThresholds: [1, 4],
          },
          {
            key: "docks" as const,
            color: "#8a95a2",
            centerDeg: 180,
            spanDeg: 120,
            ringThresholds: [1, 4],
          },
        ],
        // Radial layout as fractions of the disc radius: rings partition
        // [innerFrac, outerFrac] evenly per sector, gapFrac of white between
        // rings. sectorGapFrac is the white channel between adjacent sectors —
        // a constant linear width (also a fraction of the radius), so its
        // edges stay parallel from the inner hole to the rim.
        rings: {
          innerFrac: 0.16,
          outerFrac: 0.9,
          gapFrac: 0.06,
          sectorGapFrac: 0.07,
        },
        // The sector pieces' 3D form, meters: they rise `height` above the
        // disc top with a `bevel`-wide softened edge, and sink `embed` into
        // the disc so their underside never shows.
        relief: { height: 1.4, bevel: 0.35, embed: 0.6 },
        // Fake shading for the unlit sector pieces: side/bevel faces render at
        // this fraction of the top color, which is what makes the relief read.
        sideShade: 0.55,
        // Depleted dock (any resource at 0, or no live data): the disc
        // instance greys to `discDim` — a slight grey-out, not an offline
        // mark. Sectors with stock keep their full color.
        discDim: 0.72,
      },
    },
    // Street grid (doc01.04): the baked OSM streets etched into the land plate as
    // flat ribbons darker than the land grey, widthM meters wide (GL ignores line
    // width, so hairline lines were the alternative). One entry per baked tier
    // (largest roads first); minZoom is the semantic LOD — a tier hides below it,
    // so far out only the arterial skeleton shows and the local grid fades in on
    // approach. Bigger roads etch darker and wider. `lift` is meters above the
    // land top, just enough to win the depth test against the plate.
    streets: {
      lift: 1.5,
      tiers: [
        { color: "#10151b", widthM: 22, minZoom: 0 },
        { color: "#151a21", widthM: 14, minZoom: 10.5 },
        { color: "#191f26", widthM: 8, minZoom: 12 },
      ],
    },
  },

  // Live user-location marker (user-marker.ts): a blue disc seated like the
  // dock discs, plus — when the device has a compass — a flat arrowhead
  // hovering off the rim, pointing the device's true heading. Meters, like
  // everything here; below its natural size the marker counterscales so it
  // never drops under `screenPx` pixels across on screen.
  userMarker: {
    color: "#2f8fff",
    radius: 14,
    height: 4,
    // Arrowhead: base `halfWidth` wide, `length` long, its base `standoff`
    // meters off the disc rim, extruded `height` up.
    triangle: { length: 14, halfWidth: 9, standoff: 4, height: 3 },
    screenPx: 20,
  },

  // 3D station geometry (doc02.03), rendered in a Three.js custom layer. Sizes are
  // in meters (the layer builds meshes in a meter-scaled local frame). The puck is
  // a flat disc sitting at ground level, shown at every zoom.
  puck: {
    radius: 45,
    // The puck top is seated at `clearanceOverTube` above the tube top and the
    // disc extends downward by `height`, so raising `height` sinks its underside
    // deeper without moving the top.
    height: 20,
    // The puck's color/emissive glow is owned by the lighting system
    // (lighting.station); this block keeps only its geometry. Pucks stay visible
    // at every zoom.
    // Seated so the puck top clears the tube top by this much.
    clearanceOverTube: 3,
  },

  // 3D route track (doc02.03/doc02.07), a raised platform network. Both the caret floors and the
  // platform edges are baked by @nyc-subwhere/geometry (doc02.07) and rendered verbatim: the
  // renderer computes no ribbon geometry, so the ribbon half-width now lives solely in the bake
  // (HALF_WIDTH_M, build-ribbons.ts) with nothing here to keep in sync. `surfaceY` seats the
  // baked fill; each silhouette ring is extruded down from it by `wallHeight` as a glowing edge.
  track: {
    surfaceY: 6,
    wallHeight: 6,
    // Platform edge glow (doc02.07): the silhouette side faces are emissive so they bloom
    // under the scene pass, reading as a Tron edge of light rather than a retaining wall.
    // `edgeColor` is a cool near-white that frames every route color; `edgeEmissiveIntensity`
    // scales the self-glow (above the bloom threshold so it always glows). Putting the glow
    // on vertical faces also keeps it off the top-down far view, so it doesn't shimmer.
    edgeColor: "#dfefff",
    edgeEmissiveIntensity: 1.2,
    // Live trains ride this far to the left of travel — the center of their own
    // direction's half-ribbon (roughly half the baked ribbon width), so a train sits on its track.
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

    // Junction handling (doc02.07). Merges and branches are dissolved by the baked
    // silhouette union (build-silhouette.ts), not by per-junction reshaping — the renderer
    // just extrudes the union outline. Grade-separated crossings (union per grade band,
    // drawn at different heights) are a later pass; until then a crossing dissolves flat
    // like a merge.
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
    // Cel-style silhouette outline (train-glow.ts TrainOutlinePass): a screen-space
    // pass inks every pixel within `widthPx` outside the train silhouettes, drawn
    // after the glow composites so the dark rim reads over the bloom. Screen-space
    // keeps the width uniform at every camera angle and free of depth conflicts
    // (an inverted hull had both problems). widthPx is in device pixels.
    outline: {
      enabled: true,
      widthPx: 3,
      color: "#000000",
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
