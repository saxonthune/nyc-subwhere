import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  Direction,
  LngLat,
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
import { HeaderPanel } from "./header-panel";
import {
  InspectorPanel,
  type InspectorTarget,
  type StationView,
} from "./inspector-panel";
import { Menu } from "./menu";
import { logEstimatorReport, logPredictionError } from "./metrics";
import {
  type BoroughPolygon,
  NetworkLayer,
  type PickResult,
} from "./network-layer";
import { predictionErrors } from "./prediction-error";
import { StatsPanel } from "./stats-panel";
import { TripEstimator, colorFor, indexTracks, resolveTrip } from "./trains";

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
  // MSAA lives on the GL context, which MapLibre owns — the Three custom layer
  // shares this context, so setting antialias on THREE.WebGLRenderer is a no-op.
  // On mobile tile-based GPUs this resolves on-tile, so it's nearly free.
  antialias: true,
  // Phones report devicePixelRatio 2-3; rendering the full scene + bloom at native
  // DPR is the dominant per-frame fill cost. Cap it so the pixel count stays sane.
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
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

document.body.append(new HeaderPanel());

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
  const stationIndexByStop = new Map<string, number>();
  stationProps.forEach((p, i) => {
    stopName.set(p.stopId, p.name);
    stationIndexByStop.set(p.stopId, i);
    for (const platform of p.platforms ?? []) {
      stopName.set(platform, p.name);
      stationIndexByStop.set(platform, i);
    }
  });
  const nameOfStop = (stopId: string) =>
    stopName.get(stopId) ?? stopName.get(stopId.slice(0, -1)) ?? stopId;
  // A train-inspector stop row links to its station; resolve the directional
  // stop_id (or its parent) back to the station index, or null if it isn't one
  // we baked geometry for.
  const indexOfStop = (stopId: string) =>
    stationIndexByStop.get(stopId) ??
    stationIndexByStop.get(stopId.slice(0, -1)) ??
    null;
  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const waitLabel = (ms: number) => {
    const min = Math.round(ms / 60_000);
    return min <= 0 ? "now" : `${min} min`;
  };
  const HEADING: Record<Direction, string> = {
    N: "Northbound",
    S: "Southbound",
  };
  const routeSort = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true });

  // Live trains (doc02.04): poll the worker's render frame every ~30s and fold it
  // into the TripEstimator, then each animation frame read every Trip's position
  // off the estimator and hand the poses to the layer. The estimator re-bases each
  // frame onto the position already shown (doc02.06), so ETA jitter can no longer
  // snap a train backward. clockSkew re-bases the local clock onto the worker's
  // `asOf` so the estimate and the feed's times share one timeline.
  const trackIndex = (await (await fetch(trackIndexUrl)).json()) as TrackIndex;
  const tracks = indexTracks(trackIndex);
  const estimator = new TripEstimator();

  // Routes serving each directional stop_id, from the baked track index — the
  // static side of the station inspector (which routes stop here), independent
  // of whether any train is live right now.
  const routesByStop = new Map<string, Set<string>>();
  for (const t of trackIndex.tracks) {
    for (const s of t.stops) {
      let set = routesByStop.get(s.stopId);
      if (!set) {
        set = new Set();
        routesByStop.set(s.stopId, set);
      }
      set.add(t.routeId);
    }
  }

  let snapshot: RenderSnapshot | null = null;
  let clockSkew = 0;

  // Rider-facing station view (doc01.03): the routes that stop here (static, from
  // the track index) and, per direction, the next few trains arriving from the
  // live snapshot — the soonest upcoming arrival each Trip predicts for one of
  // this station's platforms.
  const ARRIVALS_PER_DIRECTION = 5;
  // Express-diamond variants ("6X", "7X") are the same line as their trunk; the
  // panel folds them under the trunk roundel rather than showing a separate one.
  const trunkOf = (routeId: string) => routeId.replace(/X$/, "");
  const stationView = (p: StationProperties): StationView => {
    const now = Date.now() + clockSkew;
    const platforms = new Set(p.platforms);
    const routeIds = new Set<string>();
    for (const platform of p.platforms) {
      for (const rid of routesByStop.get(platform) ?? [])
        routeIds.add(trunkOf(rid));
    }
    const routes = [...routeIds]
      .sort(routeSort)
      .map((rid) => ({ routeId: rid, color: colorFor(rid) }));

    const byDir: Record<
      Direction,
      { tripId: string; routeId: string; arrival: number }[]
    > = { N: [], S: [] };
    for (const trip of snapshot?.trips ?? []) {
      const stop = trip.upcoming.find((u) => platforms.has(u.stopId));
      if (!stop) continue;
      byDir[trip.direction].push({
        tripId: trip.tripId,
        routeId: trunkOf(trip.routeId),
        arrival: stop.arrival,
      });
    }
    const label: Record<Direction, string | undefined> = {
      N: p.northLabel,
      S: p.southLabel,
    };
    const directions = (["N", "S"] as Direction[]).map((dir) => ({
      heading: label[dir] ?? HEADING[dir],
      arrivals: byDir[dir]
        .sort((a, b) => a.arrival - b.arrival)
        .slice(0, ARRIVALS_PER_DIRECTION)
        .map((a) => ({
          tripId: a.tripId,
          routeId: a.routeId,
          color: colorFor(a.routeId),
          time: fmtTime(a.arrival),
          wait: waitLabel(a.arrival - now),
        })),
    }));
    return { routes, directions };
  };

  // Resolve a geometric pick into the raw contract data used to render it: the
  // baked StationProperties / SegmentProperties for a station or segment, and the
  // live TripState plus its computed pose for a train (doc01.03).
  const toTarget = (r: PickResult): InspectorTarget | null => {
    if (r.kind === "station") {
      const p = stationProps[r.stationIndex];
      return p
        ? { kind: "station", title: p.name, station: stationView(p) }
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
          stationIndex: indexOfStop(trip.lastKnownStop.stopId),
        },
        next: trip.upcoming.slice(0, 3).map((u) => ({
          name: nameOfStop(u.stopId),
          time: fmtTime(u.arrival),
          stationIndex: indexOfStop(u.stopId),
        })),
      },
    };
  };

  // The inspector re-derives its view from each fresh snapshot, so keep the pick
  // that's open and re-resolve it on every poll rather than freezing the click's
  // data. Closing the panel drops the pick so it stays closed (doc01.03).
  let openPick: PickResult | null = null;
  const syncInspector = () => {
    inspector.target = openPick ? toTarget(openPick) : null;
    if (openPick && !inspector.target) openPick = null;
  };
  map.on("click", (e) => {
    // Segment picks are resolvable (toTarget still handles them) but no longer
    // open the inspector — only stations and trains do. A segment click reads as
    // "clicked nothing", deselecting any open panel.
    const r = networkLayer.pick(e.point);
    openPick = r && r.kind !== "segment" ? r : null;
    syncInspector();
  });
  inspector.addEventListener("inspector-close", () => {
    openPick = null;
  });

  // Ease the camera to a point placed 33% down the screen, not dead center — the
  // panel covers the lower screen. `offset` is the target's pixel gap from the
  // container center (negative = up).
  const easeToUpperThird = (lngLat: LngLat) => {
    const h = map.getContainer().clientHeight;
    map.easeTo({ center: lngLat, offset: [0, (0.33 - 0.5) * h] });
  };

  // A timetable row selects its train: swap the panel to that train and, once,
  // ease the camera to where it's rendered.
  inspector.addEventListener("trip-select", (e) => {
    const { tripId } = (e as CustomEvent<{ tripId: string }>).detail;
    openPick = { kind: "train", tripId };
    syncInspector();
    const pose = estimator
      .poses(Date.now() + clockSkew)
      .find((p) => p.tripId === tripId);
    if (pose) easeToUpperThird(pose.lngLat);
  });

  // A train-inspector stop row selects its station: swap the panel and center it.
  inspector.addEventListener("station-select", (e) => {
    const { stationIndex } = (e as CustomEvent<{ stationIndex: number }>)
      .detail;
    openPick = { kind: "station", stationIndex };
    syncInspector();
    easeToUpperThird(lngLats[stationIndex]);
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
      // Fold the fresh arrivals into an open station/train inspector (doc01.03).
      syncInspector();
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
