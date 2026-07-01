import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  RenderSnapshot,
  SegmentProperties,
  StationProperties,
  TrackIndex,
} from "@nyc-subwhere/contract";
import segmentsUrl from "./assets/segments.geojson?url";
import stationsUrl from "./assets/stations.geojson?url";
import trackIndexUrl from "./assets/track-index.json?url";
import { InspectorPanel, type InspectorTarget } from "./inspector-panel";
import { NetworkLayer, type PickResult } from "./network-layer";
import { NETWORK_STYLE, directionOffset } from "./network-style";
import { StatsPanel } from "./stats-panel";
import { type TrainPose, indexTracks, resolveTrip } from "./trains";

const container = document.getElementById("map");

if (!container) {
  throw new Error("#map container not found");
}

// Tron view: no basemap tiles — a black background the network draws onto.
// The street-map toggle (doc02.03) later layers a dark vector basemap beneath this.
const map = new maplibregl.Map({
  container,
  center: [-73.98, 40.75], // Manhattan
  zoom: 15,
  pitch: 55,
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
map.on("load", async () => {
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

  // 3D station pucks + platform boxes (doc02.03) in a Three.js custom layer above
  // the flat network. Fetch the baked geometry once; it is static. Segments give
  // each station's track bearing so its box lies parallel to the track.
  const [stationsRes, segmentsRes] = await Promise.all([
    fetch(stationsUrl),
    fetch(segmentsUrl),
  ]);
  const stationsGeo = (await stationsRes.json()) as {
    features: {
      geometry: { coordinates: [number, number] };
      properties: StationProperties;
    }[];
  };
  const segmentsGeo = (await segmentsRes.json()) as {
    features: {
      geometry: { coordinates: [number, number][] };
      properties: SegmentProperties;
    }[];
  };
  const lngLats = stationsGeo.features.map((f) => f.geometry.coordinates);
  const segments = segmentsGeo.features.map((f) => ({
    points: f.geometry.coordinates,
    colors: f.properties.colors ?? [f.properties.color0],
  }));
  const networkLayer = new NetworkLayer(lngLats, segments);
  map.addLayer(networkLayer);
  const statsPanel = new StatsPanel();

  // Inspector (doc01.03): station and segment metadata parallel the arrays handed
  // to the layer, so a PickResult's index reads straight back to props here; a
  // train pick carries its tripId, resolved against the live snapshot below.
  const inspector = new InspectorPanel();
  document.body.appendChild(inspector);
  const stationProps = stationsGeo.features.map((f) => f.properties);
  const segmentProps = segmentsGeo.features.map((f) => f.properties);

  // Live trains (doc02.04): poll the worker's render frame every ~30s, then each
  // animation frame interpolate every Trip's Position Estimate along its baked
  // Track by wall-clock time and hand the poses to the layer. clockSkew re-bases
  // the local clock onto the worker's `asOf` so interpolation uses one timeline.
  const trackIndex = (await (await fetch(trackIndexUrl)).json()) as TrackIndex;
  const tracks = indexTracks(trackIndex);

  let snapshot: RenderSnapshot | null = null;
  let clockSkew = 0;

  // Resolve a geometric pick into the raw contract data used to render it: the
  // baked StationProperties / SegmentProperties for a station or segment, and the
  // live TripState plus its computed pose for a train (doc01.03).
  const toTarget = (r: PickResult): InspectorTarget | null => {
    if (r.kind === "station") {
      const p = stationProps[r.stationIndex];
      return p
        ? {
            kind: "station",
            title: p.name,
            data: { stationIndex: r.stationIndex, properties: p },
          }
        : null;
    }
    if (r.kind === "segment") {
      const p = segmentProps[r.segmentIndex];
      if (!p) return null;
      const coords = segmentsGeo.features[r.segmentIndex]?.geometry.coordinates;
      return {
        kind: "segment",
        title: `Track segment · ${p.routes.join("/")} ${p.direction}`,
        data: {
          segmentIndex: r.segmentIndex,
          properties: p,
          pointCount: coords?.length ?? 0,
        },
      };
    }
    const trip = snapshot?.trips.find((t) => t.tripId === r.tripId);
    if (!trip) return null;
    const res = resolveTrip(trip, tracks, Date.now() + clockSkew);
    return {
      kind: "train",
      title: `${trip.routeId} train · ${trip.tripId}`,
      data: { trip, pose: res.ok ? res.pose : null },
    };
  };

  map.on("click", (e) => {
    const r = networkLayer.pick(e.point);
    inspector.target = r ? toTarget(r) : null;
  });

  const poll = async () => {
    try {
      const res = await fetch("/api/trips");
      if (!res.ok) {
        console.warn(`/api/trips -> ${res.status}`);
        return;
      }
      snapshot = (await res.json()) as RenderSnapshot;
      clockSkew = snapshot.asOf - Date.now();
    } catch (err) {
      console.warn("trip poll failed", err);
    }
  };

  const frame = () => {
    if (snapshot) {
      const now = Date.now() + clockSkew;
      const poses: TrainPose[] = [];
      const drops = new Map<string, number>();
      for (const t of snapshot.trips) {
        const r = resolveTrip(t, tracks, now);
        if (r.ok) {
          poses.push(r.pose);
        } else {
          const key = `${r.cause}:${r.routeId}`;
          drops.set(key, (drops.get(key) ?? 0) + 1);
        }
      }
      networkLayer.setTrains(poses);
      statsPanel.update({
        total: snapshot.trips.length,
        rendered: poses.length,
        drops,
      });
    }
    requestAnimationFrame(frame);
  };

  await poll();
  setInterval(poll, 30_000);
  requestAnimationFrame(frame);
});
