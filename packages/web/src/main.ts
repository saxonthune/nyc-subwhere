import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  RenderSnapshot,
  SegmentProperties,
  StationProperties,
  TrackGraph,
  TrackIndex,
} from "@nyc-subwhere/contract";
import boroughsUrl from "./assets/boroughs.geojson?url";
import segmentsUrl from "./assets/segments.geojson?url";
import stationsUrl from "./assets/stations.geojson?url";
import trackGraphUrl from "./assets/track-graph.json?url";
import trackIndexUrl from "./assets/track-index.json?url";
import { InspectorPanel, type InspectorTarget } from "./inspector-panel";
import { Menu } from "./menu";
import { logPredictionError } from "./metrics";
import {
  type BoroughPolygon,
  NetworkLayer,
  type PickResult,
} from "./network-layer";
import { predictionErrors } from "./prediction-error";
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

// Static network geometry (doc02.05): route tubes + station pucks/boxes, all
// rendered in the Three.js custom layer (doc02.03). No flat MapLibre line/circle
// layers — the 3D layer is the only draw of the network.
map.on("load", async () => {
  // 3D route tubes + station pucks + platform boxes (doc02.03) in a Three.js
  // custom layer. Fetch the baked geometry once; it is static. Segments give
  // each station's track bearing so its box lies parallel to the track.
  const [stationsRes, segmentsRes, boroughsRes, graphRes] = await Promise.all([
    fetch(stationsUrl),
    fetch(segmentsUrl),
    fetch(boroughsUrl),
    fetch(trackGraphUrl),
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
  const boroughsGeo = (await boroughsRes.json()) as {
    features: { geometry: { coordinates: BoroughPolygon } }[];
  };
  const graph = (await graphRes.json()) as TrackGraph;
  const lngLats = stationsGeo.features.map((f) => f.geometry.coordinates);
  const segments = segmentsGeo.features.map((f) => ({
    points: f.geometry.coordinates,
    colors: f.properties.colors ?? [f.properties.color0],
  }));
  const boroughs = boroughsGeo.features.map((f) => f.geometry.coordinates);
  const networkLayer = new NetworkLayer(lngLats, segments, graph, boroughs);
  map.addLayer(networkLayer);

  // Bottom-left Menu drives the optional panels (doc01.03): a train visibility
  // toggle and the Advanced Stats panel.
  const statsPanel = new StatsPanel();
  const menu = new Menu();
  menu.options = [
    { label: "Toggle trains", onSelect: () => networkLayer.toggleTrains() },
    {
      label: "Advanced stats",
      onSelect: () => {
        statsPanel.open = !statsPanel.open;
      },
    },
  ];
  document.body.append(statsPanel, menu);

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

  const POLL_MS = 30_000;

  const poll = async () => {
    try {
      const res = await fetch("/api/trips");
      if (!res.ok) {
        console.warn(`/api/trips -> ${res.status}`);
        return;
      }
      const next = (await res.json()) as RenderSnapshot;
      // The jump each train makes here is the prior frame's prediction error;
      // measure it against the previous snapshot before overwriting (doc02.04).
      if (snapshot) {
        const rec = predictionErrors(snapshot, next, tracks);
        logPredictionError(rec);
        statsPanel.error = rec;
      }
      snapshot = next;
      clockSkew = snapshot.asOf - Date.now();
    } catch (err) {
      console.warn("trip poll failed", err);
    } finally {
      menu.nextUpdateAt = Date.now() + POLL_MS;
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
      if (statsPanel.open) {
        statsPanel.tally = {
          total: snapshot.trips.length,
          rendered: poses.length,
          drops,
        };
      }
    }
    requestAnimationFrame(frame);
  };

  await poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
});
