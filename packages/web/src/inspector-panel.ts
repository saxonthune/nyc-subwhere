import { LitElement, css, html, nothing } from "lit";

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
      min-width: 320px;
      max-width: 560px;
      background: rgba(18, 18, 20, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.06);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
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
    .trip-id {
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #8a8a8a;
      margin-bottom: 12px;
      word-break: break-all;
    }
    .heading {
      color: #b9b9b9;
    }
    .uncertain {
      margin-left: auto;
      font-size: 11px;
      color: #ffcf4d;
      border: 1px solid rgba(255, 207, 77, 0.5);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .stops {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .stop {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      padding: 5px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
    }
    .stop.last .name {
      color: #9a9a9a;
    }
    .name {
      font-weight: 500;
    }
    .role {
      font-size: 11px;
      color: #7d7d7d;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .time {
      font-variant-numeric: tabular-nums;
      color: #cfcfcf;
      white-space: nowrap;
    }
    .station {
      padding: 12px;
    }
    .routes {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      margin-bottom: 14px;
    }
    .boards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    .dir-head {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #9a9a9a;
      margin-bottom: 6px;
    }
    .arr {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .wait {
      font-variant-numeric: tabular-nums;
      color: #cfcfcf;
      white-space: nowrap;
    }
    .empty {
      color: #7d7d7d;
      font-size: 12px;
      padding: 5px 0;
    }
    .stop.link {
      cursor: pointer;
      margin: 0 -6px;
      padding-left: 6px;
      padding-right: 6px;
      border-radius: 5px;
    }
    .stop.link:hover {
      background: rgba(255, 255, 255, 0.08);
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
  updated() {
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
      <div class="panel">
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
                        ${d.arrivals.map(
                          (a) => html`
                            <li
                              class="stop link"
                              @click=${() => this.selectTrip(a.tripId)}
                            >
                              <span class="arr">
                                ${this.bullet(a.routeId, a.color, true)}
                                <span class="time">${a.time}</span>
                              </span>
                              <span class="wait">${a.wait}</span>
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
        <div class="trip-id">${v.tripId}</div>
        <ul class="stops">
          ${this.trainStopRow(v.lastStop, "departed", true)}
          ${v.next.map((s, i) =>
            this.trainStopRow(s, i === 0 ? "next" : null, false),
          )}
        </ul>
      </div>
    `;
  }

  // One train-inspector stop row. Clickable (navigates to the station) only when
  // the stop resolved to a baked station.
  private trainStopRow(s: TrainStop, role: string | null, last: boolean) {
    const clickable = s.stationIndex != null;
    return html`
      <li
        class="stop ${last ? "last" : ""} ${clickable ? "link" : ""}"
        @click=${() => clickable && this.selectStation(s.stationIndex as number)}
      >
        <span>
          <span class="name">${s.name}</span>
          ${role ? html`<span class="role"> · ${role}</span>` : nothing}
        </span>
        <span class="time">${s.time}</span>
      </li>
    `;
  }
}

customElements.define("inspector-panel", InspectorPanel);
