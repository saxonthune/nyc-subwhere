import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  BikeSnapshot,
  BikeStationInfo,
  BikeStationStatus,
  BikeStationsIndex,
  DebugGraph,
  Direction,
  LngLat,
  RenderSnapshot,
  SegmentProperties,
  StationProperties,
  StreetGrid,
  TrackGraph,
  TrackIndex,
} from "@nyc-subwhere/contract";
import { AboutPanel } from "./about-panel";
import boroughsUrl from "./assets/boroughs.geojson?url";
import debugGraphUrl from "./assets/debug-graph.json?url";
import segmentsUrl from "./assets/segments.geojson?url";
import stationsUrl from "./assets/stations.geojson?url";
import streetsUrl from "./assets/streets.json?url";
import trackGraphUrl from "./assets/track-graph.json?url";
import trackIndexUrl from "./assets/track-index.json?url";
import { BikePanel } from "./bike-panel";
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
import { UserLocationTracker } from "./user-location";

const container = document.getElementById("map");

if (!container) {
  throw new Error("#map container not found");
}

// Dev-only reload ergonomics: an edit makes Vite reload the whole page, so the
// camera pose and view mode are stashed in sessionStorage as they change and
// restored on startup. import.meta.env.DEV is statically false in production
// builds, so all of this drops out of the bundle there.
interface DevViewState {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  view: "subway" | "bike";
}
const DEV_STATE_KEY = "dev-view-state";
const devState = ((): DevViewState | null => {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = sessionStorage.getItem(DEV_STATE_KEY);
    return raw ? (JSON.parse(raw) as DevViewState) : null;
  } catch {
    return null;
  }
})();
const saveDevState = (view: "subway" | "bike") => {
  if (!import.meta.env.DEV) return;
  const c = map.getCenter();
  const state: DevViewState = {
    center: [c.lng, c.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    view,
  };
  sessionStorage.setItem(DEV_STATE_KEY, JSON.stringify(state));
};

// Tron view: no basemap tiles — a black background the network draws onto.
// The street-map toggle (doc02.03) later layers a dark vector basemap beneath this.
const map = new maplibregl.Map({
  container,
  center: devState?.center ?? [-73.9902, 40.72655],
  zoom: devState?.zoom ?? 12.29,
  pitch: devState?.pitch ?? 55,
  bearing: devState?.bearing ?? 22,
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
  const [
    stationsRes,
    segmentsRes,
    boroughsRes,
    graphRes,
    debugRes,
    streetsRes,
  ] = await Promise.all([
    fetch(stationsUrl),
    fetch(segmentsUrl),
    fetch(boroughsUrl),
    fetch(trackGraphUrl),
    fetch(debugGraphUrl),
    fetch(streetsUrl),
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
  const debug = (await debugRes.json()) as DebugGraph;
  const streets = (await streetsRes.json()) as StreetGrid;
  const lngLats = stationsGeo.features.map((f) => f.geometry.coordinates);
  const segments = segmentsGeo.features.map((f) => ({
    points: f.geometry.coordinates,
    colors: f.properties.colors ?? [f.properties.color0],
  }));
  const boroughs = boroughsGeo.features.map((f) => f.geometry.coordinates);
  const networkLayer = new NetworkLayer(
    lngLats,
    segments,
    graph,
    boroughs,
    debug,
    streets,
  );
  map.addLayer(networkLayer);
  // Debug hook (doc02.07): expose the layer so the screenshot harness can drive cycleDebug() to
  // capture a pipeline-stage centerline view deterministically. Harmless in production.
  (window as unknown as { __networkLayer?: NetworkLayer }).__networkLayer =
    networkLayer;
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
  const aboutPanel = new AboutPanel();
  document.body.append(aboutPanel);
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
    {
      label: "About",
      onSelect: () => {
        aboutPanel.open = !aboutPanel.open;
      },
    },
  ];
  // User location (user-location.ts): the menu button requests the browser
  // permissions and feeds the blue marker in the scene; its label doubles as
  // the state readout. The menu re-renders on its own 1s tick, so mutating the
  // label in place is enough.
  const locationOption = {
    label: "Enable location",
    onSelect: () => {
      if (locationTracker.active) {
        locationTracker.disable();
        locationOption.label = "Enable location";
        menu.locateVisible = false;
      } else {
        locationOption.label = "Location: on";
        menu.locateVisible = true;
        void locationTracker.enable();
      }
      menu.requestUpdate();
    },
  };
  let lastLocation: [number, number] | null = null;
  const locationTracker = new UserLocationTracker(
    (u) => {
      lastLocation = u?.lngLat ?? null;
      networkLayer.setUserLocation(lastLocation, u?.headingDeg ?? null);
    },
    () => {
      locationOption.label = "Location: blocked";
      menu.locateVisible = false;
      menu.requestUpdate();
    },
  );
  // Bar button next to the view toggle: recenter on the marker, keeping the
  // current zoom/pitch/bearing. A no-op until the first fix lands.
  menu.onLocate = () => {
    if (lastLocation) map.flyTo({ center: lastLocation });
  };
  menu.options = [...menu.options, locationOption];

  // Debug views (doc02.07): one exclusive cycle over the pipeline's published debug layers —
  // selecting one hides the tracks and draws that stage's centerlines as skinny pipes. Only shown
  // when the bake published layers. The label reflects the active view; the menu re-renders on its
  // own 1s tick, so mutating the label in place is enough.
  if (debug.layers.length > 0) {
    const debugOption = {
      label: "Debug view: off",
      onSelect: () => {
        debugOption.label = `Debug view: ${networkLayer.cycleDebug()}`;
        menu.requestUpdate();
      },
    };
    menu.options = [...menu.options, debugOption];
  }
  document.body.append(statsPanel, menu);

  // Interaction nudge (doc01.04 NG): appears above the bar after a delay from
  // load, stays for a further delay, then hides. A Trip/Station tap
  // (map.on("click") below) or any UI tap (the capture listener below fires
  // for anything outside the map canvas, which covers the banner itself) cuts
  // it short at whichever stage it's in — including canceling it before it
  // ever appears (NG-2).
  let nudgeState: "pending" | "shown" | "gone" = "pending";
  let nudgeTimer = setTimeout(() => {
    nudgeState = "shown";
    menu.nudgeVisible = true;
    nudgeTimer = setTimeout(() => {
      nudgeState = "gone";
      menu.nudgeVisible = false;
    }, 10_000);
  }, 10_000);
  function cancelNudge() {
    if (nudgeState === "gone") return;
    nudgeState = "gone";
    clearTimeout(nudgeTimer);
    menu.nudgeVisible = false;
  }
  menu.onNudgeDismiss = cancelNudge;
  document.addEventListener(
    "click",
    (e) => {
      if (nudgeState !== "gone" && !container.contains(e.target as Node)) {
        cancelNudge();
      }
    },
    true,
  );

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
    // Bike-station picks open the bike panel in the click handler; they never
    // resolve to an inspector target.
    if (r.kind !== "train") return null;
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
  // Citi Bike docks (doc02.09 data): identity fetched once, on first entry into
  // Bike View — until then the discs simply don't exist. Live counts are fetched
  // on tap, cached at the snapshot's own 30s cadence so repeated taps within one
  // frame reuse the response.
  const bikePanel = new BikePanel();
  document.body.appendChild(bikePanel);
  let bikeInfos: BikeStationInfo[] = [];
  const loadBikeStations = async () => {
    if (bikeInfos.length > 0) return;
    try {
      const res = await fetch("/api/bike-stations");
      if (!res.ok) return;
      const idx = (await res.json()) as BikeStationsIndex;
      bikeInfos = idx.stations;
      networkLayer.setBikeStations(bikeInfos.map((s) => [s.lon, s.lat]));
    } catch (err) {
      console.warn("bike stations fetch failed", err);
    }
  };

  let bikeStatus = new Map<string, BikeStationStatus>();
  let bikeStatusAt = 0;
  const freshBikeStatus = async () => {
    if (Date.now() - bikeStatusAt >= POLL_MS) {
      const res = await fetch("/api/bikes");
      if (res.ok) {
        const snap = (await res.json()) as BikeSnapshot;
        bikeStatus = new Map(snap.stations.map((s) => [s.stationId, s]));
        bikeStatusAt = Date.now();
      }
    }
    return bikeStatus;
  };

  // Map-side dock scoreboards (bike-scoreboard.ts): push the same three
  // available counts the modal shows, aligned by index with the dock positions.
  // Runs on entering Bike View and on each poll tick; freshBikeStatus's own
  // cache keeps that to one /api/bikes fetch per cadence.
  const pushBikeCounts = async () => {
    if (bikeInfos.length === 0) return;
    try {
      const status = await freshBikeStatus();
      networkLayer.setBikeCounts(
        bikeInfos.map((info) => {
          const s = status.get(info.stationId);
          return s
            ? { classicBikes: s.classicBikes, ebikes: s.ebikes, docks: s.docks }
            : null;
        }),
      );
    } catch (err) {
      console.warn("bike counts push failed", err);
    }
  };

  // One row per field of the /api/bikes entry — a raw dump of the live counts,
  // to be shaped into a rider-facing layout later.
  const bikeRows = (
    info: BikeStationInfo,
    status: BikeStationStatus | undefined,
  ) =>
    status
      ? [
          { label: "Classic bikes", value: `${status.classicBikes}` },
          { label: "Ebikes", value: `${status.ebikes}` },
          { label: "Parking spaces", value: `${status.docks}` },
          { label: "Bikes disabled", value: `${status.bikesDisabled ?? 0}` },
          { label: "Docks disabled", value: `${status.docksDisabled ?? 0}` },
          { label: "Renting", value: status.renting ? "yes" : "no" },
          { label: "Returning", value: status.returning ? "yes" : "no" },
          { label: "Capacity", value: `${info.capacity}` },
        ]
      : [{ label: "Live data", value: "unavailable" }];

  let openBikeIndex: number | null = null;
  const openBikeStation = async (index: number) => {
    const info = bikeInfos[index];
    if (!info) return;
    openBikeIndex = index;
    // Show the header immediately; the rows fill in when the counts arrive.
    bikePanel.target = { title: info.name, rows: [] };
    let status: BikeStationStatus | undefined;
    try {
      status = (await freshBikeStatus()).get(info.stationId);
    } catch (err) {
      console.warn("bike status fetch failed", err);
    }
    // A tap elsewhere may have closed or retargeted the panel mid-fetch.
    if (openBikeIndex !== index) return;
    bikePanel.target = {
      title: info.name,
      rows: bikeRows(info, status),
      resources: status
        ? {
            classicBikes: status.classicBikes,
            ebikes: status.ebikes,
            docks: status.docks,
          }
        : null,
    };
  };
  const closeBikePanel = () => {
    openBikeIndex = null;
    bikePanel.target = null;
  };
  bikePanel.addEventListener("bike-panel-close", () => {
    openBikeIndex = null;
  });

  map.on("click", (e) => {
    const r = networkLayer.pick(e.point);
    if (r?.kind === "train" || r?.kind === "station") cancelNudge();
    if (r?.kind === "bikeStation") {
      void openBikeStation(r.bikeStationIndex);
      return;
    }
    closeBikePanel();
    // Segment picks are resolvable (toTarget still handles them) but no longer
    // open the inspector — only stations and trains do. A segment click reads as
    // "clicked nothing", deselecting any open panel.
    openPick = r && r.kind !== "segment" ? r : null;
    syncInspector();
  });
  inspector.addEventListener("inspector-close", () => {
    openPick = null;
  });

  // View toggle (doc01.04): flip the layer's representation, and honor BV-3 — an
  // inspector opened in Subway View must not linger over an inert Bike View.
  let viewMode: "subway" | "bike" = "subway";
  menu.onViewToggle = () => {
    viewMode = viewMode === "subway" ? "bike" : "subway";
    menu.viewMode = viewMode;
    networkLayer.setViewMode(viewMode);
    if (viewMode === "bike") {
      openPick = null;
      syncInspector();
      void loadBikeStations().then(pushBikeCounts);
    } else {
      // Symmetric with BV-3: a dock modal must not linger over Subway View.
      closeBikePanel();
    }
    saveDevState(viewMode);
  };
  if (import.meta.env.DEV) {
    // moveend misses pure pitch/rotate gestures, which end with their own events.
    map.on("moveend", () => saveDevState(viewMode));
    map.on("pitchend", () => saveDevState(viewMode));
    map.on("rotateend", () => saveDevState(viewMode));
    if (devState?.view === "bike") menu.onViewToggle();
  }

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
    if (viewMode === "bike") void pushBikeCounts();
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
