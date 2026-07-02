import { LitElement, css, html, nothing } from "lit";
import type { PredictionErrorRecord } from "./prediction-error";

export interface DropTally {
  total: number;
  rendered: number;
  drops: Map<string, number>;
}

export interface CameraReadout {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

// Advanced Stats (doc01.03): live per-frame drop diagnostics in a panel styled
// like the inspector, opened from the Menu. `open` gates it; `tally` is refreshed
// each frame by main.ts only while open, so a closed panel costs no re-renders.
export class StatsPanel extends LitElement {
  static properties = {
    open: { attribute: false, type: Boolean },
    tally: { attribute: false },
    error: { attribute: false },
    camera: { attribute: false },
  };
  declare open: boolean;
  declare tally: DropTally | null;
  /** Latest prediction-error record, refreshed once per poll. */
  declare error: PredictionErrorRecord | null;
  /** Live camera pose, refreshed on map move while open — for the shot-at harness. */
  declare camera: CameraReadout | null;

  constructor() {
    super();
    this.open = false;
    this.tally = null;
    this.error = null;
    this.camera = null;
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
      min-width: 220px;
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
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre;
      color: #d6d6d6;
    }
  `;

  private close() {
    this.open = false;
  }

  render() {
    if (!this.open) return nothing;
    return html`
      <div class="panel">
        <header>
          <span class="title">Advanced Stats</span>
          <button class="close" @click=${this.close} aria-label="Close">
            ×
          </button>
        </header>
        <pre class="body">${[
          cameraLines(this.camera),
          this.tally ? lines(this.tally) : "…",
          errorLines(this.error),
        ]
          .filter(Boolean)
          .join("\n\n")}</pre>
      </div>
    `;
  }
}

function cameraLines(c: CameraReadout | null): string {
  if (!c) return "";
  const n = (v: number, d: number) => v.toFixed(d);
  // Second line is paste-ready args for `just shot <out> …` so a spot can be
  // handed straight to the screenshot harness.
  return [
    `center: ${n(c.lng, 5)}, ${n(c.lat, 5)}  z${n(c.zoom, 2)} p${Math.round(c.pitch)} b${Math.round(c.bearing)}`,
    `shot: ${n(c.lng, 5)} ${n(c.lat, 5)} ${n(c.zoom, 2)} ${Math.round(c.pitch)} ${Math.round(c.bearing)}`,
  ].join("\n");
}

function lines(t: DropTally): string {
  const dropped = t.total - t.rendered;
  return [
    `total: ${t.total}`,
    `rendered: ${t.rendered}`,
    `dropped: ${dropped}`,
    ...[...t.drops.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => {
        const [cause, routeId] = key.split(":");
        return `${cause} ${routeId}: ${count}`;
      }),
  ].join("\n");
}

function errorLines(e: PredictionErrorRecord | null): string {
  if (!e) return "";
  const m = e.meters;
  const worstRoute = Object.entries(e.byRoute).sort(
    ([, a], [, b]) => b.mean - a.mean,
  )[0];
  return [
    `— re-anchor jump (m), n=${e.counts.matched} —`,
    `p50: ${m.p50}  p95: ${m.p95}  max: ${m.max}`,
    `mean: ${m.mean}  bias: ${m.meanSigned >= 0 ? "+" : ""}${m.meanSigned}`,
    worstRoute ? `worst route: ${worstRoute[0]} (${worstRoute[1].mean})` : "",
    `switched: ${e.counts.lineSwitched}  in/out: ${e.counts.appeared}/${e.counts.disappeared}`,
  ]
    .filter(Boolean)
    .join("\n");
}

customElements.define("stats-panel", StatsPanel);
