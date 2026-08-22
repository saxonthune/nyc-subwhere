import { LitElement, css, html, nothing, svg } from "lit";
import type { PropertyValues } from "lit";
import { NETWORK_STYLE } from "./network-style";

// A Citi Bike dock's live stats, resolved for display by main.ts: one row per
// field of the worker's /api/bikes entry. The panel only lays the rows out —
// labels and formatted values arrive ready. `resources` carries the three
// available counts (all GBFS *_available figures, so disabled bikes/docks are
// already excluded) that drive the gauge and legend.
export interface BikeResources {
  classicBikes: number;
  ebikes: number;
  docks: number;
}

export interface BikeStationTarget {
  title: string;
  rows: { label: string; value: string }[];
  resources?: BikeResources | null;
}

// Legend rows, keyed to the gauge's slices. Swatch colors are the dark-panel
// palette — the gauge's own docks grey (network-style.ts) is a shade darker
// because it sits on the white disc, not here on the dark panel.
const LEGEND: { key: keyof BikeResources; label: string; color: string }[] = [
  { key: "classicBikes", label: "Classic bikes", color: "#22d3ee" },
  { key: "ebikes", label: "Ebikes", color: "#ff5fd2" },
  { key: "docks", label: "Parking", color: "#aab4bf" },
];

const DEG2RAD = Math.PI / 180;
const GAUGE_SIZE = 148;

// One ring segment of one sector, as an SVG path — the 2D twin of
// bike-disc-gauge.ts's sectorGeometry. Bearings are compass radians (0 = up,
// clockwise, which matches SVG's y-down plane directly). The white channel
// between sectors keeps a constant linear width: each radius gets its own
// angular inset, asin(halfGap / r), so the straight edges joining the arcs run
// parallel to the sector boundary.
function sectorPath(
  c: number,
  b0: number,
  b1: number,
  r0: number,
  r1: number,
  halfGap: number,
): string {
  const pt = (r: number, b: number) =>
    `${(c + r * Math.sin(b)).toFixed(2)},${(c - r * Math.cos(b)).toFixed(2)}`;
  const in0 = Math.asin(Math.min(1, halfGap / r0));
  const in1 = Math.asin(Math.min(1, halfGap / r1));
  const largeOut = b1 - b0 - 2 * in1 > Math.PI ? 1 : 0;
  const largeIn = b1 - b0 - 2 * in0 > Math.PI ? 1 : 0;
  return [
    `M${pt(r1, b0 + in1)}`,
    `A${r1},${r1} 0 ${largeOut} 1 ${pt(r1, b1 - in1)}`,
    `L${pt(r0, b1 - in0)}`,
    `A${r0},${r0} 0 ${largeIn} 0 ${pt(r0, b0 + in0)}`,
    "Z",
  ].join(" ");
}

// Modal for a tapped Citi Bike dock, docked to the lower screen like the
// inspector (doc01.03). A reactive `target`: set it to show, null to close.
// Two views: the overview (legend + 2D gauge) and, behind the Advanced Stats
// button, the full table of api data.
export class BikePanel extends LitElement {
  static properties = {
    target: { attribute: false },
    advanced: { state: true },
  };
  declare target: BikeStationTarget | null;
  declare advanced: boolean;

  constructor() {
    super();
    this.target = null;
    this.advanced = false;
  }

  static styles = css`
    :host {
      position: fixed;
      left: 50%;
      bottom: 24px;
      /* Shrink-to-fit of a fixed box at left:50% caps out at half the viewport;
         max-content sizing lets the row reach its natural width instead. */
      width: max-content;
      transform: translateX(-50%);
      z-index: 10;
      font: 14px/1.4 system-ui, sans-serif;
      color: #e8e8e8;
    }
    .panel {
      min-width: 280px;
      max-width: min(780px, calc(100vw - 32px));
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
      display: flex;
      align-items: center;
    }
    .legend {
      display: flex;
      flex-direction: column;
      align-self: stretch;
      justify-content: center;
      padding: 12px 16px;
      border-right: 1px solid rgba(255, 255, 255, 0.1);
    }
    .legend-row {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 4px 0;
    }
    .swatch {
      width: 13px;
      height: 13px;
      border-radius: 4px;
    }
    .legend-label {
      color: #b9b9b9;
      padding-right: 8px;
    }
    .legend-count {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .gauge-cell {
      padding: 12px 16px;
    }
    .nav {
      appearance: none;
      margin-top: 10px;
      padding: 5px 10px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: #cfd6dd;
      font: 12px system-ui, sans-serif;
      cursor: pointer;
    }
    .nav:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }
    .stats {
      flex-direction: column;
      align-items: stretch;
      padding-bottom: 10px;
    }
    .stats .nav {
      align-self: center;
      margin-top: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 6px 0;
    }
    td {
      padding: 5px 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
    }
    tr:first-child td {
      border-top: none;
    }
    .label {
      color: #b9b9b9;
    }
    .value {
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: #e8e8e8;
    }
  `;

  // A new station starts back on the overview; same-station data refreshes
  // keep whichever view is open.
  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("target")) {
      const prev = changed.get("target") as BikeStationTarget | null;
      if (!this.target || this.target.title !== prev?.title)
        this.advanced = false;
    }
  }

  private showStats = () => {
    this.advanced = true;
  };

  private showOverview = () => {
    this.advanced = false;
  };

  private close() {
    this.target = null;
    // Let main.ts drop its open-station state, so the panel stays closed
    // instead of reopening on the next data refresh.
    this.dispatchEvent(
      new CustomEvent("bike-panel-close", { bubbles: true, composed: true }),
    );
  }

  // The map gauge in 2D: same config (network-style.ts), same layout math as
  // bike-disc-gauge.ts, minus the Manhattan-grid rotation — here the parking
  // sector points straight down. Rings light per that sector's thresholds,
  // and the disc greys when any resource is depleted.
  private renderGauge(res: BikeResources) {
    const g = NETWORK_STYLE.bikeView.bikeStation.gauge;
    const C = GAUGE_SIZE / 2;
    const R = C - 2;
    const halfGap = (g.rings.sectorGapFrac * R) / 2;
    const depleted = g.slices.some((s) => res[s.key] === 0);
    const shade = Math.round(255 * g.discDim);
    const paths = [];
    for (const slice of g.slices) {
      const bands = slice.ringThresholds.length;
      const band =
        (g.rings.outerFrac -
          g.rings.innerFrac -
          g.rings.gapFrac * (bands - 1)) /
        bands;
      const b0 = (slice.centerDeg - slice.spanDeg / 2) * DEG2RAD;
      const b1 = (slice.centerDeg + slice.spanDeg / 2) * DEG2RAD;
      for (const [ring, min] of slice.ringThresholds.entries()) {
        if (res[slice.key] < min) continue;
        const r0 = (g.rings.innerFrac + ring * (band + g.rings.gapFrac)) * R;
        const r1 = r0 + band * R;
        paths.push(
          svg`<path d=${sectorPath(C, b0, b1, r0, r1, halfGap)} fill=${slice.color}
            stroke="#000" stroke-width="1.5" stroke-linejoin="round" />`,
        );
      }
    }
    return html`
      <svg
        width=${GAUGE_SIZE}
        height=${GAUGE_SIZE}
        viewBox="0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}"
        role="img"
      >
        <circle
          cx=${C}
          cy=${C}
          r=${R}
          fill=${depleted ? `rgb(${shade},${shade},${shade})` : "#fff"}
          stroke="#000"
          stroke-width="2"
        />
        ${paths}
      </svg>
    `;
  }

  private renderOverview(res: BikeResources) {
    return html`
      <div class="body">
        <div class="legend">
          ${LEGEND.map(
            ({ key, label, color }) => html`
              <div class="legend-row">
                <span class="swatch" style="background:${color}"></span>
                <span class="legend-label">${label}</span>
                <span class="legend-count">${res[key]}</span>
              </div>
            `,
          )}
          <button class="nav" @click=${this.showStats}>
            Advanced Stats
          </button>
        </div>
        <div class="gauge-cell">${this.renderGauge(res)}</div>
      </div>
    `;
  }

  // The raw api table. Back returns to the overview; without live resources
  // there is no overview to return to, so the button drops.
  private renderStats(t: BikeStationTarget) {
    return html`
      <div class="body stats">
        <table>
          ${t.rows.map(
            (r) => html`
              <tr>
                <td class="label">${r.label}</td>
                <td class="value">${r.value}</td>
              </tr>
            `,
          )}
        </table>
        ${
          t.resources
            ? html`
                <button class="nav" @click=${this.showOverview}>
                  Back
                </button>
              `
            : nothing
        }
      </div>
    `;
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
          t.resources && !this.advanced
            ? this.renderOverview(t.resources)
            : this.renderStats(t)
        }
      </div>
    `;
  }
}

customElements.define("bike-panel", BikePanel);
