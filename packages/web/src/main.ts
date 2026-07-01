import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import segmentsUrl from "./assets/segments.geojson?url";
import stationsUrl from "./assets/stations.geojson?url";
import { NETWORK_STYLE, directionOffset } from "./network-style";

const container = document.getElementById("map");

if (!container) {
  throw new Error("#map container not found");
}

// Tron view: no basemap tiles — a black background the network draws onto.
// The street-map toggle (doc02.03) later layers a dark vector basemap beneath this.
const map = new maplibregl.Map({
  container,
  center: [-73.98, 40.75], // Manhattan
  zoom: 11,
  pitch: 0,
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#000000" },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

// Static network geometry (doc02.05): route lines + station dots from the baked
// GTFS assets. The Three.js train layer renders above these later (doc02.03).
map.on("load", () => {
  map.addSource("segments", { type: "geojson", data: segmentsUrl });
  map.addSource("stations", { type: "geojson", data: stationsUrl });

  // Semantic-zoom LOD (doc01.03): both directions share a corridor and coincide
  // when zoomed out; line-offset fans them apart into parallel tracks as you zoom
  // in. N/S shapes run antiparallel, so an equal offset pushes them to opposite
  // sides. Applied identically to every line layer so stripes stay aligned.
  // Breakpoints live in network-style.ts (retuned often).
  const offset = directionOffset();
  const width = NETWORK_STYLE.lineWidth;

  // A conflated segment carries the distinct colors of every Route on it as flat
  // props (doc02.05): color0 is the solid base, color1/color2 are stripes. NYC's
  // per-trunk palette keeps this to 3 colors max, so base + two stripes suffice.

  // Tron glow: a wide, blurred, low-opacity halo under the crisp base.
  map.addLayer({
    id: "route-glow",
    type: "line",
    source: "segments",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color0"],
      "line-width": NETWORK_STYLE.glow.width,
      "line-blur": NETWORK_STYLE.glow.blur,
      "line-opacity": NETWORK_STYLE.glow.opacity,
      "line-offset": offset,
    },
  });
  // Base: solid colors[0] on every segment (the only layer 1-color trunks need).
  map.addLayer({
    id: "route-base",
    type: "line",
    source: "segments",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color0"],
      "line-width": width,
      "line-offset": offset,
    },
  });
  // 2-color candy-cane: colors[1] dashed over the base → 50/50 stripes.
  map.addLayer({
    id: "route-stripe-2",
    type: "line",
    source: "segments",
    filter: ["==", ["get", "colorCount"], 2],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": ["get", "color1"],
      "line-width": width,
      "line-dasharray": NETWORK_STYLE.dash2,
      "line-offset": offset,
    },
  });
  // 3-color: colors[1] fills the first third, colors[2] the middle third (phase-
  // shifted via a leading near-zero dash, since MapLibre has no dash offset), base
  // shows through the last third.
  map.addLayer({
    id: "route-stripe-3a",
    type: "line",
    source: "segments",
    filter: ["==", ["get", "colorCount"], 3],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": ["get", "color1"],
      "line-width": width,
      "line-dasharray": NETWORK_STYLE.dash3a,
      "line-offset": offset,
    },
  });
  map.addLayer({
    id: "route-stripe-3b",
    type: "line",
    source: "segments",
    filter: ["==", ["get", "colorCount"], 3],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": ["get", "color2"],
      "line-width": width,
      "line-dasharray": NETWORK_STYLE.dash3b,
      "line-offset": offset,
    },
  });

  map.addLayer({
    id: "stations",
    type: "circle",
    source: "stations",
    paint: {
      "circle-radius": NETWORK_STYLE.station.radius,
      "circle-color": NETWORK_STYLE.station.color,
      "circle-stroke-width": NETWORK_STYLE.station.strokeWidth,
      "circle-stroke-color": NETWORK_STYLE.station.strokeColor,
    },
  });
});
