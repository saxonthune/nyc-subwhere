import type {
  BusDepartures,
  BusEvent,
  BusLive,
  BusNetwork,
  BusCurb as Curb,
} from "@nyc-subwhere/contract";
import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { Map as CityMap, GeoJSONSource, PointLike } from "maplibre-gl";

const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});
const eventTime = (e: BusEvent) =>
  html`<time datetime=${new Date(e.time).toISOString()}>${clock.format(e.time)}</time> <small>${e.basis}</small>`;
async function read<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Bus data unavailable");
  return res.json();
}
class BusPanel extends LitElement {
  static styles = css`
 :host{position:fixed;right:16px;bottom:64px;z-index:9;width:min(360px,calc(100vw - 32px));font:15px/1.45 system-ui,sans-serif;color:#f7f9fe}
 section{background:#263950;padding:16px;border-radius:10px;box-shadow:0 8px 28px #0008;max-height:55vh;overflow:auto}
 header,.visit{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
 h2{font-size:18px;margin:0}
 button{background:#416080;color:white;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}
 details{padding:8px 0;border-top:2px solid #506982}
 summary{cursor:pointer} .visit>span:last-child{flex-shrink:0} small{color:#c4dfec} time{font-variant-numeric:tabular-nums;white-space:nowrap}
 p{margin:8px 0} ol{padding-left:20px} li{margin:6px 0}
 `;
  curb?: Curb;
  rows?: BusDepartures;
  status = "";
  names = new Map<string, Curb>();
  onClose = () => {};
  render() {
    if (!this.curb && !this.status) return nothing;
    return html`<section aria-label="Bus departures"><header><h2>${this.curb?.name ?? "Buses"}</h2><button @click=${this.onClose} aria-label="Close bus details">Close</button></header>
  ${this.status ? html`<p role="status">${this.status}</p>` : nothing}
  ${repeat(
    this.rows?.departures ?? [],
    (row) => `${row.tripKey}/${row.boarding.sequence}`,
    (
      row,
    ) => html`<details data-trip-key=${row.tripKey} data-sequence=${row.boarding.sequence} data-service-date=${row.serviceDate}><summary><strong>${row.routeName}</strong> ${row.headsign} <span>${eventTime(row.boarding)}</span></summary>
  <p>Service date <time>${row.serviceDate.slice(0, 4)}-${row.serviceDate.slice(4, 6)}-${row.serviceDate.slice(6)}</time></p>
  ${row.boarding.observedAt ? html`<p>Prediction updated <time>${clock.format(row.boarding.observedAt)}</time></p>` : nothing}
  <ol>${row.downstream.map((call) => html`<li data-stop-id=${call.stopId} data-sequence=${call.sequence}><div class="visit"><span>${this.names.get(call.stopId)?.name ?? call.stopId}</span><span>${eventTime(call)}</span></div>${call.canAlight ? nothing : html`<small>Alighting unavailable</small>`}</li>`)}</ol></details>`,
  )}
  </section>`;
  }
}
customElements.define("bus-panel", BusPanel);

export class BusOverlay {
  active = false;
  private generation = 0;
  private lookup = 0;
  private network?: BusNetwork;
  private panel = new BusPanel();
  private layers: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(private map: CityMap) {
    document.body.append(this.panel);
    this.panel.onClose = () => this.clear();
  }
  private clear() {
    if (this.map.getLayer("bus-curbs"))
      this.map.setPaintProperty("bus-curbs", "circle-color", "#ffda92");
    this.lookup++;
    this.panel.rows = undefined;
    this.panel.curb = undefined;
    this.panel.status = "";
    this.panel.requestUpdate();
  }
  set(active: boolean) {
    this.active = active;
    const generation = ++this.generation;
    clearInterval(this.timer);
    this.clear();
    for (const id of this.layers.reverse()) {
      this.map.removeLayer(id);
      this.map.removeSource(id);
    }
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
        this.map.addSource(id, { type: "geojson", data: url });
        this.map.addLayer({
          id,
          type: "line",
          source: id,
          paint: {
            "line-color": "#ecac5e",
            "line-width": 2,
            "line-opacity": 0.72,
          },
        });
        this.layers.push(id);
      }
      this.map.addSource("bus-curbs", {
        type: "geojson",
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
            2,
            15,
            5,
            18,
            8,
          ],
          "circle-color": "#ffda92",
          "circle-stroke-color": "#553814",
          "circle-stroke-width": 1.5,
        },
      });
      this.layers.push("bus-curbs");
      this.map.addSource("bus-vehicles", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      this.map.addLayer({
        id: "bus-vehicles",
        type: "circle",
        source: "bus-vehicles",
        paint: {
          "circle-radius": 6,
          "circle-color": "#68f2d5",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#143f48",
        },
      });
      this.layers.push("bus-vehicles");
      this.panel.status = "";
      this.panel.requestUpdate();
      const refresh = async () => {
        if (this.busy || generation !== this.generation) return;
        this.busy = true;
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
          this.busy = false;
        }
        if (this.panel.curb && generation === this.generation)
          void this.select(this.panel.curb);
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
    this.map.getSource<GeoJSONSource>("bus-vehicles")?.setData({
      type: "FeatureCollection",
      features: positions.map((p) => ({
        type: "Feature",
        properties: {
          tripKey: p.tripKey,
          vehicleId: p.vehicleId,
          observedAt: p.observedAt,
        },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
    });
  }
  pick(point: PointLike) {
    if (!this.active || !this.map.getLayer("bus-curbs")) return false;
    const feature = this.map.queryRenderedFeatures(point, {
      layers: ["bus-curbs"],
    })[0];
    const curb = feature && this.panel.names.get(feature.properties.stopId);
    if (!curb) {
      this.clear();
      return false;
    }
    void this.select(curb);
    return true;
  }
  private async select(curb: Curb) {
    if (!this.network) return;
    const ticket = ++this.lookup;
    this.map.setPaintProperty("bus-curbs", "circle-color", [
      "case",
      ["==", ["get", "stopId"], curb.stopId],
      "#ffffff",
      "#ffda92",
    ]);
    if (this.panel.curb?.stopId !== curb.stopId) {
      this.panel.rows = undefined;
      this.panel.status = "Loading departures…";
    }
    this.panel.curb = curb;
    this.panel.requestUpdate();
    const p = new URLSearchParams({
      stopId: curb.stopId,
      after: String(Date.now()),
      networkVersion: this.network.networkVersion,
      limit: "6",
    });
    try {
      const rows = await read<BusDepartures>(`/api/bus/departures?${p}`);
      if (ticket !== this.lookup) return;
      this.panel.rows = rows;
      this.panel.status = rows.departures.length
        ? ""
        : "No departures in the next hour.";
    } catch {
      if (ticket !== this.lookup) return;
      this.panel.status = "Departure times could not be refreshed.";
    }
    this.panel.requestUpdate();
  }
}
