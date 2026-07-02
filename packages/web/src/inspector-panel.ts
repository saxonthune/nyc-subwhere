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
}

// A clicked train, resolved for display: route + heading, the last stop it was
// known at, and the stops ahead. Times are already localized strings and stopIds
// already resolved to station names by main.ts — the panel only lays them out.
export interface TrainView {
  routeId: string;
  tripId: string; // per-train identifier from the feed
  color: string; // "#RRGGBB", the route color
  heading: string; // "Northbound" | "Southbound"
  uncertain: boolean;
  lastStop: { name: string; time: string };
  next: { name: string; time: string }[];
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
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      color: #fff;
      font-weight: 700;
      font-size: 16px;
      /* Pin the glyph's line box to its own height so grid centering isn't thrown
         off by the panel's inherited line-height (~19.6px). */
      line-height: 1;
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
  `;

  private close() {
    this.target = null;
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
            : html`<pre class="body">${JSON.stringify(t.data, null, 2)}</pre>`
        }
      </div>
    `;
  }

  private renderTrain(v: TrainView) {
    return html`
      <div class="train">
        <div class="route">
          <span class="bullet" style="background:${v.color}">${v.routeId}</span>
          <span class="heading">${v.heading}</span>
          ${
            v.uncertain
              ? html`<span class="uncertain">position uncertain</span>`
              : nothing
          }
        </div>
        <div class="trip-id">${v.tripId}</div>
        <ul class="stops">
          <li class="stop last">
            <span>
              <span class="name">${v.lastStop.name}</span>
              <span class="role"> · departed</span>
            </span>
            <span class="time">${v.lastStop.time}</span>
          </li>
          ${v.next.map(
            (s, i) => html`
              <li class="stop">
                <span>
                  <span class="name">${s.name}</span>
                  ${i === 0 ? html`<span class="role"> · next</span>` : nothing}
                </span>
                <span class="time">${s.time}</span>
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }
}

customElements.define("inspector-panel", InspectorPanel);
