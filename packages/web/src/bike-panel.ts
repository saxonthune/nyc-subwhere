import { LitElement, css, html, nothing } from "lit";

// A Citi Bike dock's live stats, resolved for display by main.ts: one row per
// field of the worker's /api/bikes entry. The panel only lays the rows out —
// labels and formatted values arrive ready.
export interface BikeStationTarget {
  title: string;
  rows: { label: string; value: string }[];
}

// Modal for a tapped Citi Bike dock, docked to the lower screen like the
// inspector (doc01.03). A reactive `target`: set it to show, null to close.
export class BikePanel extends LitElement {
  static properties = { target: { attribute: false } };
  declare target: BikeStationTarget | null;

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
      min-width: 280px;
      max-width: 480px;
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

  private close() {
    this.target = null;
    // Let main.ts drop its open-station state, so the panel stays closed
    // instead of reopening on the next data refresh.
    this.dispatchEvent(
      new CustomEvent("bike-panel-close", { bubbles: true, composed: true }),
    );
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
      </div>
    `;
  }
}

customElements.define("bike-panel", BikePanel);
