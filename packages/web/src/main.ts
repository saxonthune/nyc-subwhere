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
import { logEstimatorReport, logPredictionError } from "./metrics";
import {
  type BoroughPolygon,
  NetworkLayer,
  type PickResult,
} from "./network-layer";
import { predictionErrors } from "./prediction-error";
import { StatsPanel } from "./stats-panel";
import { TripEstimator, indexTracks, resolveTrip } from "./trains";

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

// Debug hook (doc02.05): expose the map so the junction screenshot harness can
// jumpTo a named location deterministically. Harmless in production.
(window as unknown as { __map?: maplibregl.Map }).__map = map;

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
  // Screenshot harness readiness (doc02.05): the empty style is `loaded()` well
  // before this async handler builds the layer, so the harness gates on this flag
  // instead — set only once the track geometry is actually in the scene.
  (window as unknown as { __networkReady?: boolean }).__networkReady = true;

  // Bottom-left Menu drives the optional panels (doc01.03): a train visibility
  // toggle and the Advanced Stats panel.
  const statsPanel = new StatsPanel();
  const syncCamera = () => {
    if (!statsPanel.open) return;
    const c = map.getCenter();
    statsPanel.camera = {
      lng: c.lng,
      lat: c.lat,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
  };
  map.on("move", syncCamera);
  const menu = new Menu();
  menu.options = [
    { label: "Toggle trains", onSelect: () => networkLayer.toggleTrains() },
    { label: "Toggle lighting", onSelect: () => networkLayer.toggleLighting() },
    {
      label: "Advanced stats",
      onSelect: () => {
        statsPanel.open = !statsPanel.open;
        syncCamera();
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

  // Directional stop_id ("127N") -> station name, for the train inspector. Each
  // station carries its parent id and its platform ids; also index the parent so
  // a bare id (or one whose suffix we strip) still resolves.
  const stopName = new Map<string, string>();
  for (const p of stationProps) {
    stopName.set(p.stopId, p.name);
    for (const platform of p.platforms ?? []) stopName.set(platform, p.name);
  }
  const nameOfStop = (stopId: string) =>
    stopName.get(stopId) ?? stopName.get(stopId.slice(0, -1)) ?? stopId;
  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // Live trains (doc02.04): poll the worker's render frame every ~30s and fold it
  // into the TripEstimator, then each animation frame read every Trip's position
  // off the estimator and hand the poses to the layer. The estimator re-bases each
  // frame onto the position already shown (doc02.06), so ETA jitter can no longer
  // snap a train backward. clockSkew re-bases the local clock onto the worker's
  // `asOf` so the estimate and the feed's times share one timeline.
  const trackIndex = (await (await fetch(trackIndexUrl)).json()) as TrackIndex;
  const tracks = indexTracks(trackIndex);
  const estimator = new TripEstimator();

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
    const pose = res.ok ? res.pose : null;
    return {
      kind: "train",
      title: `${trip.routeId} train`,
      train: {
        routeId: trip.routeId,
        tripId: trip.tripId,
        color: pose?.color ?? "#9a9a9a",
        heading: trip.direction === "S" ? "Southbound" : "Northbound",
        uncertain: pose?.uncertain ?? false,
        lastStop: {
          name: nameOfStop(trip.lastKnownStop.stopId),
          time: fmtTime(trip.lastKnownStop.at),
        },
        next: trip.upcoming.slice(0, 3).map((u) => ({
          name: nameOfStop(u.stopId),
          time: fmtTime(u.arrival),
        })),
      },
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
      // Fold the fresh frame into the running estimate, re-basing each Trip onto
      // where it is being rendered right now (doc02.06). Uses the just-updated
      // clockSkew so the re-base time matches the frame loop's clock. The report
      // measures the estimate against reality and its visible jumps.
      const report = estimator.ingest(snapshot, tracks, Date.now() + clockSkew);
      logEstimatorReport(report);
      statsPanel.estimator = report;
    } catch (err) {
      console.warn("trip poll failed", err);
    } finally {
      menu.nextUpdateAt = Date.now() + POLL_MS;
    }
  };

  const frame = () => {
    if (snapshot) {
      const poses = estimator.poses(Date.now() + clockSkew);
      networkLayer.setTrains(poses);
      if (statsPanel.open) {
        statsPanel.tally = {
          total: snapshot.trips.length,
          rendered: poses.length,
          drops: estimator.drops,
        };
      }
    }
    requestAnimationFrame(frame);
  };

  await poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
});
