import { LitElement, css, html, nothing } from "lit";
import { bikingIcon, locateIcon, subwayIcon } from "./icons";

export interface MenuOption {
  label: string;
  onSelect: () => void;
}

// Bottom-left "Menu" button whose panel rises above it (doc01.03). The host is
// bottom-anchored, so the panel — laid out before the button in flow — grows the
// stack upward when shown. Options are plain {label, onSelect}; the menu stays
// open after a selection so toggles can be flipped in a row.
export class Menu extends LitElement {
  static properties = {
    options: { attribute: false },
    open: { attribute: false, type: Boolean },
    nextUpdateAt: { attribute: false, type: Number },
    viewMode: { attribute: false },
    onViewToggle: { attribute: false },
    nudgeVisible: { attribute: false, type: Boolean },
    onNudgeDismiss: { attribute: false },
    locateVisible: { attribute: false, type: Boolean },
    onLocate: { attribute: false },
  };
  declare options: MenuOption[];
  declare open: boolean;
  /** Epoch ms of the next data poll; 0 until the first poll is scheduled. */
  declare nextUpdateAt: number;
  declare viewMode: "subway" | "bike";
  declare onViewToggle?: () => void;
  /** Interaction nudge shown above the bar at load (doc01.04 NG-1). */
  declare nudgeVisible: boolean;
  declare onNudgeDismiss?: () => void;
  /** Center-on-location button, shown only while location is enabled. */
  declare locateVisible: boolean;
  declare onLocate?: () => void;

  private tick?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.options = [];
    this.open = false;
    this.nextUpdateAt = 0;
    this.viewMode = "subway";
    this.nudgeVisible = false;
    this.locateVisible = false;
  }

  // The countdown is derived from wall-clock, so re-render once a second rather
  // than on a data change — nextUpdateAt only moves every ~30s.
  connectedCallback() {
    super.connectedCallback();
    this.tick = setInterval(() => this.requestUpdate(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this.tick);
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      font: 14px/1.4 system-ui, sans-serif;
    }
    button {
      appearance: none;
      cursor: pointer;
      color: #e8e8e8;
      background: rgba(18, 18, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 8px 12px;
    }
    .toggle {
      font-weight: 600;
    }
    .toggle:hover {
      background: rgba(40, 40, 44, 0.95);
    }
    .panel {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      padding: 6px;
      background: rgba(18, 18, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }
    .panel button {
      text-align: left;
      background: transparent;
      border: none;
      white-space: nowrap;
    }
    .panel button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icon {
      width: 16px;
      height: 16px;
      display: block;
    }
    .locate {
      line-height: 1;
    }
    .nudge {
      cursor: pointer;
      color: #eaf3ff;
      background: rgba(46, 92, 150, 0.55);
      border: 1px solid rgba(140, 190, 255, 0.4);
      border-radius: 6px;
      padding: 8px 12px;
      max-width: 260px;
    }
    .countdown {
      color: #b8b8b8;
      background: rgba(18, 18, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 8px 10px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    /* Narrow screens: "Menu" collapses to a ☰ glyph and the countdown to just "Ns". */
    .short {
      display: none;
    }
    @media (max-width: 480px) {
      .full {
        display: none;
      }
      .short {
        display: inline;
      }
      .toggle .short {
        font-size: 18px;
        line-height: 1;
      }
    }
  `;

  private toggle() {
    this.open = !this.open;
  }

  // Full and short forms of the countdown; the short one ("12s") is shown on narrow
  // screens where "next update: 12s" would crowd the bar (see the media query).
  private countdown(): { full: string; short: string } {
    if (!this.nextUpdateAt) return { full: "next update: …", short: "…" };
    const secs = Math.ceil((this.nextUpdateAt - Date.now()) / 1000);
    if (secs <= 0) return { full: "updating…", short: "…" };
    return { full: `next update: ${secs}s`, short: `${secs}s` };
  }

  render() {
    const cd = this.countdown();
    return html`
      ${
        this.nudgeVisible
          ? html`<div class="nudge" @click=${() => this.onNudgeDismiss?.()}>
            Hint: tap a train or station
          </div>`
          : nothing
      }
      ${
        this.open
          ? html`<div class="panel">
            ${this.options.map(
              (o) => html`<button @click=${o.onSelect}>${o.label}</button>`,
            )}
          </div>`
          : nothing
      }
      <div class="bar">
        <button class="toggle" @click=${this.toggle}>
          <span class="full">Menu</span><span class="short">☰</span>
        </button>
        <button class="toggle" @click=${() => this.onViewToggle?.()}>
          <span class="full">${
            // The label names the view a press switches TO (doc01.04 TG-3).
            this.viewMode === "subway" ? "Bike view" : "Subway view"
          }</span
          ><span class="short"
            >${this.viewMode === "subway" ? bikingIcon : subwayIcon}</span
          >
        </button>
        ${
          this.locateVisible
            ? html`<button
              class="toggle locate"
              title="Center on my location"
              aria-label="Center on my location"
              @click=${() => this.onLocate?.()}
            >
              ${locateIcon}
            </button>`
            : nothing
        }
        <span class="countdown">
          <span class="full">${cd.full}</span><span class="short">${cd.short}</span>
        </span>
      </div>
    `;
  }
}

customElements.define("menu-panel", Menu);
