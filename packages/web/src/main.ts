import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import segmentsUrl from "./assets/segments.geojson?url";
import stationsUrl from "./assets/stations.geojson?url";

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

  // Tron glow: a wide, blurred, low-opacity copy of each line under a crisp core.
  map.addLayer({
    id: "route-glow",
    type: "line",
    source: "segments",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 6,
      "line-blur": 6,
      "line-opacity": 0.4,
    },
  });
  map.addLayer({
    id: "route-core",
    type: "line",
    source: "segments",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 1.5 },
  });

  map.addLayer({
    id: "stations",
    type: "circle",
    source: "stations",
    paint: {
      "circle-radius": 3,
      "circle-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#000000",
    },
  });
});
