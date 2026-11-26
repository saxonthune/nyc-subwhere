import type {
  BusActivity,
  BusDepartures,
  BusLive,
  BusNetwork,
  BusTrip,
  BusCurb as Curb,
} from "@nyc-subwhere/contract";
import type {
  Map as CityMap,
  ExpressionSpecification,
  GeoJSONSource,
  PointLike,
} from "maplibre-gl";
import { BusPanel } from "./bus-panel";

const routeWidth: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  10,
  0.9,
  15,
  1.8,
  18,
  2.6,
];

const busColors = {
  route: "#997de8",
  curb: "#dccbfa",
  curbRim: "#45385c",
  selectedCurb: "#ffffff",
  inactiveRoute: "#8a939e",
  inactiveCurb: "#bfc5cd",
  vehicle: "#60f5ed",
  vehicleRim: "#134a53",
  chevron: "#148d99",
};

// A north-facing sprite, shared by every vehicle and rotated by the symbol layer.
function registerBusSprites(map: CityMap) {
  const scale = 3;
  for (const directed of [true, false]) {
    const id = directed ? "bus-forward" : "bus-no-heading";
    if (map.hasImage(id)) continue;
    const canvas = document.createElement("canvas");
    canvas.width = 12 * scale;
    canvas.height = 22 * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Cannot draw bus marker");
    ctx.scale(scale, scale);
    ctx.fillStyle = busColors.vehicleRim;
    ctx.beginPath();
    ctx.roundRect(0, 0, 12, 22, 2.5);
    ctx.fill();
    ctx.fillStyle = busColors.vehicle;
    ctx.beginPath();
    ctx.roundRect(1, 1, 10, 20, 1.5);
    ctx.fill();
    if (directed) {
      ctx.strokeStyle = busColors.chevron;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(3, 8);
      ctx.lineTo(6, 5);
      ctx.lineTo(9, 8);
      ctx.stroke();
    }
    map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), {
      pixelRatio: scale,
    });
  }
}

async function read<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Bus data unavailable");
  return res.json();
}
export class BusOverlay {
  active = false;
  private generation = 0;
  private lookup = 0;
  private network?: BusNetwork;
  private panel = new BusPanel();
  private layers: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private inactive = new Set<string>();
  private shapeLayers = new Map<
    string,
    { source: string; active?: Set<string> }
  >();
  private after = 0;
  constructor(private map: CityMap) {
    document.body.append(this.panel);
    this.panel.onClose = () => this.clear();
    this.panel.onStop = (id) => {
      const curb = this.panel.names.get(id);
      if (curb) {
        this.center([curb.lon, curb.lat]);
        void this.select(curb);
      }
    };
    this.panel.onTrip = (key) => void this.selectTrip(key, true);
    this.panel.onMore = () => {
      if (this.panel.curb) void this.select(this.panel.curb, true);
    };
  }
  private center(coords: [number, number]) {
    this.map.easeTo({
      center: coords,
      offset: [0, -this.map.getContainer().clientHeight * 0.17],
    });
  }
  private clear() {
    if (this.panel.curb && this.map.getSource("bus-curbs"))
      this.map.setFeatureState(
        { source: "bus-curbs", id: this.panel.curb.stopId },
        { selected: false },
      );
    if (this.map.getLayer("bus-selected"))
      this.map.setFilter("bus-selected", false);
    this.lookup++;
    this.panel.curb = undefined;
    this.panel.tripKey = undefined;
    this.panel.trip = undefined;
    this.panel.rows = undefined;
    this.panel.status = "";
    this.panel.requestUpdate();
  }
  set(active: boolean) {
    this.active = active;
    const generation = ++this.generation;
    clearInterval(this.timer);
    this.clear();
    for (const id of [...this.layers].reverse()) this.map.removeLayer(id);
    for (const id of this.layers)
      if (this.map.getSource(id)) this.map.removeSource(id);
    this.shapeLayers.clear();
    this.inactive.clear();
    this.panel.vehicles.clear();
    this.layers = [];
    this.network = undefined;
    if (active) void this.load(generation);
  }
  private async load(generation: number) {
    this.panel.status = "Loading bus stops…";
    this.panel.requestUpdate();
    try {
      const network = await read<BusNetwork>("/api/bus/network");
      const curbs = await read<Curb[]>(network.stopsUrl);
      if (generation !== this.generation) return;
      this.network = network;
      this.panel.names = new Map(curbs.map((s) => [s.stopId, s]));
      for (const [i, url] of network.shapesUrls.entries()) {
        const id = `bus-shape-${i}`;
        this.map.addSource(id, {
          type: "geojson",
          data: url,
          promoteId: "shapeId",
        });
        this.map.addLayer({
          id,
          type: "line",
          source: id,
          paint: {
            "line-color": busColors.route,
            "line-width": routeWidth,
            "line-opacity": 0.72,
          },
        });
        this.layers.push(id);
        this.shapeLayers.set(url, { source: id });
      }
      // Draw active shapes above every grey shape, including overlapping feeds.
      for (const { source } of this.shapeLayers.values()) {
        const id = `${source}-active`;
        this.map.addLayer({
          id,
          source,
          type: "line",
          paint: {
            "line-color": busColors.route,
            "line-width": routeWidth,
            "line-opacity": [
              "case",
              ["boolean", ["feature-state", "active"], false],
              0.8,
              0,
            ],
          },
        });
        this.layers.push(id);
      }
      this.map.addSource("bus-curbs", {
        type: "geojson",
        promoteId: "stopId",
        data: {
          type: "FeatureCollection",
          features: curbs.map((s) => ({
            type: "Feature",
            properties: { stopId: s.stopId },
            geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          })),
        },
      });
      this.map.addLayer({
        id: "bus-curbs",
        type: "circle",
        source: "bus-curbs",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            1.5,
            15,
            3.8,
            18,
            6.5,
          ],
          "circle-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            busColors.selectedCurb,
            ["boolean", ["feature-state", "inactive"], false],
            busColors.inactiveCurb,
            busColors.curb,
          ],
          "circle-stroke-color": busColors.curbRim,
          "circle-stroke-width": 1,
        },
      });
      this.layers.push("bus-curbs");
      registerBusSprites(this.map);
      this.map.addSource("bus-vehicles", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      this.map.addLayer({
        id: "bus-selected",
        source: "bus-vehicles",
        type: "circle",
        filter: false,
        paint: {
          "circle-radius": 15,
          "circle-color": "#0e303b",
          "circle-opacity": 0.65,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#cdfef8",
        },
      });
      this.layers.push("bus-selected");
      this.map.addLayer({
        id: "bus-vehicles",
        type: "symbol",
        source: "bus-vehicles",
        layout: {
          "icon-image": [
            "case",
            ["has", "bearing"],
            "bus-forward",
            "bus-no-heading",
          ],
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            0.65,
            14,
            0.9,
            18,
            1.2,
          ],
          "icon-rotate": ["coalesce", ["get", "bearing"], 0],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      this.layers.push("bus-vehicles");
      this.panel.status = "";
      this.panel.requestUpdate();
      const refreshActivity = async () => {
        try {
          const activity = await read<BusActivity>(
            `/api/bus/activity?networkVersion=${network.networkVersion}`,
          );
          if (
            generation === this.generation &&
            activity.networkVersion === network.networkVersion
          )
            this.applyActivity(activity);
        } catch {
          /* Keep the last confirmed classification until the next refresh. */
        }
      };
      let refreshing = false;
      const refresh = async () => {
        if (refreshing || generation !== this.generation) return;
        refreshing = true;
        const activity = refreshActivity();
        try {
          const current = await read<BusNetwork>("/api/bus/network");
          if (generation !== this.generation) return;
          if (current.networkVersion !== network.networkVersion) {
            this.set(true);
            return;
          }
          const frame = await read<BusLive>(
            `/api/bus/live?positionsOnly=1&networkVersion=${network.networkVersion}`,
          );
          if (generation !== this.generation) return;
          this.positions(frame.positions);
        } catch {
          if (generation === this.generation) this.positions([]);
        } finally {
          await activity;
          refreshing = false;
        }
        if (this.panel.curb && generation === this.generation)
          void this.select(this.panel.curb);
        else if (this.panel.tripKey && generation === this.generation)
          void this.selectTrip(this.panel.tripKey, false);
      };
      this.timer = setInterval(() => void refresh(), 30000);
      void refresh();
    } catch {
      if (generation === this.generation) {
        this.panel.status =
          "Bus stops could not be loaded. Reopen buses to retry.";
        this.panel.requestUpdate();
      }
    }
  }
  private positions(positions: BusLive["positions"]) {
    this.panel.vehicles = new Map(positions.map((p) => [p.tripKey, p]));
    this.panel.requestUpdate();
    this.map.getSource<GeoJSONSource>("bus-vehicles")?.setData({
      type: "FeatureCollection",
      features: positions.map((p) => ({
        type: "Feature",
        properties: {
          tripKey: p.tripKey,
          vehicleId: p.vehicleId,
          observedAt: p.observedAt,
          ...(p.routeBearing != null ? { bearing: p.routeBearing } : {}),
        },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
    });
  }
  private applyActivity(activity: BusActivity) {
    const active = new Set(activity.stops);
    for (const id of this.panel.names.keys())
      this.setInactive(id, !active.has(id));
    // Only update changed shape IDs. Replacing a layer filter here would force
    // the six citywide geometry sources to lay out their tiles again.
    for (const [url, layer] of this.shapeLayers) {
      const next = new Set(activity.shapes[url] ?? []);
      if (!layer.active)
        this.map.setPaintProperty(
          layer.source,
          "line-color",
          busColors.inactiveRoute,
        );
      for (const id of layer.active ?? [])
        if (!next.has(id))
          this.map.setFeatureState(
            { source: layer.source, id },
            { active: false },
          );
      for (const id of next)
        if (!layer.active?.has(id))
          this.map.setFeatureState(
            { source: layer.source, id },
            { active: true },
          );
      layer.active = next;
    }
  }
  private setInactive(id: string, inactive: boolean) {
    if (this.inactive.has(id) === inactive) return;
    if (inactive) this.inactive.add(id);
    else this.inactive.delete(id);
    this.map.setFeatureState({ source: "bus-curbs", id }, { inactive });
  }
  pick(point: PointLike) {
    if (!this.active || !this.map.getLayer("bus-curbs")) return false;
    const layers = this.map.getLayer("bus-vehicles")
      ? ["bus-vehicles", "bus-curbs"]
      : ["bus-curbs"];
    const hits = this.map.queryRenderedFeatures(point, { layers });
    const bus = hits.find((f) => f.layer.id === "bus-vehicles");
    if (bus) {
      void this.selectTrip(bus.properties.tripKey, true);
      return true;
    }
    const stop = hits.find((f) => f.layer.id === "bus-curbs");
    const curb = stop && this.panel.names.get(stop.properties.stopId);
    if (curb) {
      void this.select(curb);
      return true;
    }
    this.clear();
    return false;
  }
  private async selectTrip(key: string, center: boolean) {
    if (!this.network) return;
    const changed = this.panel.tripKey !== key;
    if (changed) this.clear();
    this.panel.tripKey = key;
    if (changed)
      this.map.setFilter("bus-selected", ["==", ["get", "tripKey"], key]);
    if (changed) this.panel.status = "Loading upcoming stops…";
    const position = this.panel.vehicles.get(key);
    if (center && position) this.center([position.lon, position.lat]);
    const ticket = ++this.lookup;
    this.panel.requestUpdate();
    const p = new URLSearchParams({
      tripKey: key,
      networkVersion: this.network.networkVersion,
    });
    try {
      const trip = await read<BusTrip>(`/api/bus/trip?${p}`);
      if (ticket !== this.lookup) return;
      this.panel.trip = trip;
      this.panel.status = "";
      if (center && !position) {
        const target =
          trip.vehicle ?? this.panel.names.get(trip.calls[0]?.stopId);
        if (target) this.center([target.lon, target.lat]);
      }
    } catch {
      if (ticket !== this.lookup) return;
      this.panel.status = "Trip details could not be refreshed.";
    }
    this.panel.requestUpdate();
  }
  private async select(curb: Curb, more = false) {
    if (!this.network) return;
    const changed = this.panel.curb?.stopId !== curb.stopId;
    if (changed) this.clear();
    this.panel.curb = curb;
    this.map.setFeatureState(
      { source: "bus-curbs", id: curb.stopId },
      { selected: true },
    );
    if (changed) this.panel.status = "Loading departures…";
    this.panel.requestUpdate();
    const ticket = ++this.lookup;
    const old = this.panel.rows;
    const after = more ? this.after : Date.now();
    const p = new URLSearchParams({
      stopId: curb.stopId,
      after: String(after),
      networkVersion: this.network.networkVersion,
      limit: String(Math.min(100, Math.max(15, old?.departures.length ?? 0))),
    });
    if (more && old?.nextCursor) p.set("cursor", old.nextCursor);
    try {
      const rows = await read<BusDepartures>(`/api/bus/departures?${p}`);
      if (ticket !== this.lookup) return;
      if (more && old)
        rows.departures = [...old.departures, ...rows.departures];
      // Preserve the extent of an already expanded timetable across refreshes.
      while (
        !more &&
        rows.nextCursor &&
        rows.departures.length < (old?.departures.length ?? 0)
      ) {
        p.set("cursor", rows.nextCursor);
        const next = await read<BusDepartures>(`/api/bus/departures?${p}`);
        if (ticket !== this.lookup) return;
        rows.departures.push(...next.departures);
        rows.nextCursor = next.nextCursor;
      }
      this.after = after;
      this.panel.rows = rows;
      this.panel.status = rows.departures.length
        ? ""
        : "No departures in the next hour.";
      this.setInactive(curb.stopId, !rows.departures.length);
    } catch {
      if (ticket !== this.lookup) return;
      this.panel.status = "Departure times could not be refreshed.";
    }
    this.panel.requestUpdate();
  }
}
