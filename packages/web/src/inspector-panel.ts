import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";

// The inspector shows what drove the geometry that was clicked (doc01.03).
// Stations and segments dump their raw baked props (`data`) for a developer;
// a train gets a rider-facing `train` view — resolved names and localized times —
// assembled by main.ts from the live snapshot.
export interface InspectorTarget {
  kind: "segment" | "station" | "train";
  title: string;
  data?: unknown;
  train?: TrainView;
  station?: StationView;
}

// A clicked train, resolved for display: route + heading, the last stop it was
// known at, and the stops ahead. Times are already localized strings and stopIds
// already resolved to station names by main.ts — the panel only lays them out.
// `stationIndex` links a row back to its station (null if not a baked station).
export interface TrainStop {
  name: string;
  time: string;
  stationIndex: number | null;
}
export interface TrainView {
  label: string;
  routeId: string;
  tripId: string; // per-train identifier from the feed
  color: string; // "#RRGGBB", the route color
  heading: string; // "Northbound" | "Southbound"
  uncertain: boolean;
  lastStop: TrainStop;
  next: TrainStop[];
}

// A clicked station, resolved for display by main.ts: the routes that stop here
// (from the baked track index) and, per direction, the soonest trains arriving
// from the live snapshot. Times/waits are already formatted; the panel lays out.
export interface StationView {
  stopId: string;
  routes: RouteBullet[];
  directions: DirectionBoard[];
}
export interface RouteBullet {
  routeId: string;
  color: string; // "#RRGGBB"
}
export interface DirectionBoard {
  heading: string; // "Northbound" | "Southbound"
  arrivals: StationArrival[];
}
export interface StationArrival {
  label: string;
  tripId: string; // selecting a row inspects + centers this train
  routeId: string;
  color: string;
  time: string; // localized clock time of arrival
  wait: string; // "now" | "N min"
}

// Modal inspector docked to the lower screen (doc01.03). A reactive `target`:
// set it to show, set it to null to close. No decorators — `static properties`
// keeps this off the shared tsconfig's decorator settings.
export class InspectorPanel extends LitElement {
  static properties = { target: { attribute: false } };
  declare target: InspectorTarget | null;

  constructor() {
    super();
    this.target = null;
  }

  static styles = css`
    :host {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      z-index: 10;
      font: 14px/1.4 system-ui, sans-serif;
      color: #e8e8e8;
    }
    .panel {
      width: min(320px,calc(100vw - 24px));
      box-sizing: border-box;
      background: #253545;
      color: #f2f5f8;
      border-radius: 8px;
      box-shadow: 0 8px 32px #0007;
      overflow: hidden;
    }
    .panel.station-panel {
      width: min(340px,calc(100vw - 24px));
    }
    @media (max-width: 1440px) {
      :host {
        bottom: 76px;
      }
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: #30455a;
    }
    .title {
      font-weight: 600;
    }
    .close {
      appearance: none;
      border: none;
      background: transparent;
      color: inherit;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
    }
    .close:hover {
      color: #fff;
    }
    .body {
      margin: 0;
      padding: 10px 12px;
      max-height: 42vh;
      overflow: auto;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre;
      color: #d6d6d6;
    }
    .train {
      padding: 12px;
    }
    .route {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }
    .bullet {
      width: 30px;
      height: 30px;
      flex: 0 0 auto;
    }
    .bullet.sm {
      width: 20px;
      height: 20px;
    }
    .bullet text {
      fill: #fff;
      font-family: system-ui, sans-serif;
      font-weight: 700;
      font-size: 16px;
    }
    .train-id {
      font: 600 13px/1.4 ui-monospace,monospace;
      letter-spacing: .025em;
      color: #d1e5f8;
    }
    .train-id-label {
      font-size: 12px;
      color: #c3cfda;
      margin-right: 6px;
    }
    .heading {
      color: #e3eaf1;
    }
    .uncertain {
      margin-left: auto;
      font-size: 11px;
      color: #ffe6a6;
      background: #504532;
      border-radius: 4px;
      padding: 2px 5px;
    }
    .stops {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      scrollbar-width: thin;
      scrollbar-color: #7d91a4 #253545;
    }
    .train .stops {
      max-height: min(126px,32dvh);
      margin-top: 8px;
    }
    .stop {
      border-top: 1px solid #425161;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      box-sizing: border-box;
      width: 100%;
      padding: 5px 2px;
      color: inherit;
      text-align: left;
      font: inherit;
    }
    button.row {
      appearance: none;
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    button.row:hover {
      background: #354b60;
    }
    button:focus-visible {
      outline: 2px solid #92d8ff;
      outline-offset: -2px;
    }
    .name {
      font-weight: 500;
    }
    .role {
      display: inline-block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .04em;
      padding: 1px 4px;
      margin-left: 3px;
      border-radius: 3px;
      background: #425568;
      color: #e1eaf4;
    }
    .time,.wait {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .station {
      padding: 12px;
    }
    .routes {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .boards {
      display: grid;
      grid-template-columns: repeat(2,minmax(0,1fr));
      column-gap: 12px;
      row-gap: 4px;
    }
    .board {
      display: grid;
      grid-row: span 2;
      grid-template-rows: subgrid;
      min-width: 0;
    }
    .dir-head {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: #c3cfda;
    }
    .board .stops {
      max-height: min(208px,36dvh);
    }
    .arrival {
      display: grid;
      grid-template-columns: 20px 1fr auto;
      column-gap: 4px;
      row-gap: 2px;
      font-size: 13px;
    }
    .arrival .train-id {
      grid-column: 2/-1;
      font-size: 12px;
    }
    .wait {
      color: #c2d0db;
    }
    .empty {
      color: #c2d0db;
      font-size: 12px;
      padding: 5px 0;
    }
  `;

  // A timetable row was clicked: main.ts inspects and centers that train.
  private selectTrip(tripId: string) {
    this.dispatchEvent(
      new CustomEvent("trip-select", {
        detail: { tripId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // A train-inspector stop was clicked: main.ts inspects and centers that station.
  private selectStation(stationIndex: number) {
    this.dispatchEvent(
      new CustomEvent("station-select", {
        detail: { stationIndex },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private close() {
    this.target = null;
    // Let main.ts drop the pick it re-resolves each poll, so a closed panel
    // stays closed instead of reopening on the next snapshot.
    this.dispatchEvent(
      new CustomEvent("inspector-close", { bubbles: true, composed: true }),
    );
  }

  // Guarantee the route glyph is centered in its circle. CSS/SVG anchors align the
  // font's em box, not the glyph's ink — a capital sits high (cap-height above the
  // baseline, empty descender space below) and off horizontally by its side
  // bearing. The only font-independent fix is to measure the actually-rendered
  // bounding box and translate its center onto the circle center (15, 15).
  private selectedKey?: string;
  updated() {
    const key = this.target?.train?.tripId ?? this.target?.station?.stopId;
    if (key !== this.selectedKey) {
      for (const list of this.renderRoot.querySelectorAll(".stops"))
        list.scrollTop = 0;
      this.selectedKey = key;
    }
    const texts =
      this.renderRoot.querySelectorAll<SVGTextElement>(".bullet text");
    for (const text of texts) {
      text.removeAttribute("transform"); // measure the untranslated glyph
      const b = text.getBBox();
      const dx = 15 - (b.x + b.width / 2);
      const dy = 15 - (b.y + b.height / 2);
      text.setAttribute("transform", `translate(${dx} ${dy})`);
    }
  }

  render() {
    const t = this.target;
    if (!t) return nothing;
    return html`
      <div class="panel ${t.station ? "station-panel" : ""}">
        <header>
          <span class="title">${t.title}</span>
          <button class="close" @click=${this.close} aria-label="Close">
            ×
          </button>
        </header>
        ${
          t.train
            ? this.renderTrain(t.train)
            : t.station
              ? this.renderStation(t.station)
              : html`<pre class="body">${JSON.stringify(t.data, null, 2)}</pre>`
        }
      </div>
    `;
  }

  // A route roundel. viewBox is a fixed 30×30; CSS (`.bullet` / `.bullet.sm`)
  // sizes it, and `updated()` recenters the glyph against its measured ink box.
  private bullet(routeId: string, color: string, small = false) {
    return html`
      <svg
        class="bullet ${small ? "sm" : ""}"
        viewBox="0 0 30 30"
        aria-hidden="true"
      >
        <circle cx="15" cy="15" r="15" fill=${color}></circle>
        <text x="15" y="15" text-anchor="middle">${routeId}</text>
      </svg>
    `;
  }

  private renderStation(v: StationView) {
    return html`
      <div class="station">
        <div class="routes">
          ${v.routes.map((r) => this.bullet(r.routeId, r.color))}
        </div>
        <div class="boards">
          ${v.directions.map(
            (d) => html`
              <div class="board">
                <div class="dir-head">${d.heading}</div>
                ${
                  d.arrivals.length
                    ? html`<ul class="stops">
                        ${repeat(
                          d.arrivals,
                          (a) => a.tripId,
                          (a) => html`
                            <li class="stop">
                              <button class="row arrival" title=${a.tripId} @click=${() => this.selectTrip(a.tripId)}>
                                ${this.bullet(a.routeId, a.color, true)}
                                <span class="time">${a.time}</span><span class="wait">${a.wait}</span>
                                <span class="train-id">${a.label}</span>
                              </button>
                            </li>
                          `,
                        )}
                      </ul>`
                    : html`<div class="empty">No trains predicted</div>`
                }
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderTrain(v: TrainView) {
    return html`
      <div class="train">
        <div class="route">
          ${this.bullet(v.routeId, v.color)}
          <span class="heading">${v.heading}</span>
          ${
            v.uncertain
              ? html`<span class="uncertain">position uncertain</span>`
              : nothing
          }
        </div>
        <div title=${v.tripId}><span class="train-id-label">Train ID</span><strong class="train-id">${v.label}</strong></div>
        <ul class="stops">
          ${this.trainStopRow(v.lastStop, "last known")}
          ${v.next.map((s, i) => this.trainStopRow(s, i === 0 ? "next" : null))}
        </ul>
      </div>
    `;
  }

  // One train-inspector stop row. Clickable (navigates to the station) only when
  // the stop resolved to a baked station.
  private trainStopRow(s: TrainStop, role: string | null) {
    const content = html`<span><span class="name">${s.name}</span>${role ? html`<span class="role">${role}</span>` : nothing}</span><span class="time">${s.time}</span>`;
    const index = s.stationIndex;
    return html`<li class="stop">${index === null ? html`<div class="row">${content}</div>` : html`<button class="row" @click=${() => this.selectStation(index)}>${content}</button>`}</li>`;
  }
}

customElements.define("inspector-panel", InspectorPanel);
