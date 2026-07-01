import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const container = document.getElementById("map");

if (!container) {
  throw new Error("#map container not found");
}

console.info(`MapLibre GL JS v${maplibregl.getVersion()}`);

// The MapLibre map and its Three.js custom render layer are constructed here.
