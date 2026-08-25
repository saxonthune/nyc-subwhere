import { LitElement, css, html, nothing } from "lit";
import type { PredictionErrorRecord } from "./prediction-error";
import type { EstimatorReport } from "./trains";

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
    estimator: { attribute: false },
    camera: { attribute: false },
    copied: { state: true },
  };
  declare open: boolean;
  declare tally: DropTally | null;
  /** Latest prediction-error record, refreshed once per poll. */
  declare error: PredictionErrorRecord | null;
  /** Latest estimator reconciliation report, refreshed once per poll. */
  declare estimator: EstimatorReport | null;
  /** Live camera pose, refreshed on map move while open — for the shot-at harness. */
  declare camera: CameraReadout | null;
  /** Momentary "copied" flag for the shot line's click-to-copy affordance. */
  declare copied: boolean;

  constructor() {
    super();
    this.open = false;
    this.tally = null;
    this.error = null;
    this.estimator = null;
    this.camera = null;
    this.copied = false;
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
      max-width: calc(100vw - 16px);
    }
    .panel {
      min-width: 220px;
      max-width: 100%;
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
      /* The drop list can run long on a phone; scroll inside the panel
         rather than growing it past the top of the viewport. */
      max-height: 60vh;
      overflow: auto;
    }
    /* Panel text isn't selectable (body-wide user-select: none, kept for the
       mobile long-press callout). The shot line is the one value worth copying,
       so make it a one-tap copy target instead. */
    .shot {
      cursor: pointer;
      border-radius: 3px;
      padding: 0 2px;
      margin: 0 -2px;
    }
    .shot:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .shot.copied {
      color: #7ee787;
    }
  `;

  // `open` is controlled by main.ts's overlay owner (one overlay at a time),
  // so the close button reports the press rather than flipping local state —
  // same shape as the inspector's "inspector-close".
  private close() {
    this.dispatchEvent(new CustomEvent("stats-close"));
  }

  private async copyShot(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 1200);
    } catch {
      // Clipboard denied (insecure context / permissions) — leave the line as-is.
    }
  }

  render() {
    if (!this.open) return nothing;
    const c = this.camera;
    const shot = c ? shotArgs(c) : "";
    return html`
      <div class="panel">
        <header>
          <span class="title">Advanced Stats</span>
          <button class="close" @click=${this.close} aria-label="Close">
            ×
          </button>
        </header>
        <pre class="body">${
          c
            ? html`${centerLine(c)}
<span
              class="shot ${this.copied ? "copied" : ""}"
              title="Click to copy"
              @click=${() => this.copyShot(shot)}
              >shot: ${shot}${this.copied ? "  ✓ copied" : ""}</span
            >

`
            : nothing
        }${[
          this.tally ? lines(this.tally) : "…",
          estimatorLines(this.estimator),
          errorLines(this.error),
        ]
          .filter(Boolean)
          .join("\n\n")}</pre>
      </div>
    `;
  }
}

function centerLine(c: CameraReadout): string {
  const n = (v: number, d: number) => v.toFixed(d);
  return `center: ${n(c.lng, 5)}, ${n(c.lat, 5)}  z${n(c.zoom, 2)} p${Math.round(c.pitch)} b${Math.round(c.bearing)}`;
}

// Paste-ready args for `just shot <out> …` so a spot can be handed straight to
// the screenshot harness.
function shotArgs(c: CameraReadout): string {
  const n = (v: number, d: number) => v.toFixed(d);
  return `${n(c.lng, 5)} ${n(c.lat, 5)} ${n(c.zoom, 2)} ${Math.round(c.pitch)} ${Math.round(c.bearing)}`;
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

function estimatorLines(e: EstimatorReport | null): string {
  if (!e) return "";
  const sign = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
  const honesty =
    e.truth.n === 0
      ? ""
      : e.truth.signed < 0
        ? "behind — honest"
        : "PAST platform!";
  return [
    `— estimator (m), n=${e.matched} —`,
    `vs feed (optimistic): p50 ${e.drift.p50}  bias ${sign(e.drift.signed)}`,
    `vs OBSERVED pass: bias ${sign(e.truth.signed)} n=${e.truth.n} ${honesty}`,
    `visual jump p50: ${e.jump.p50}  p95: ${e.jump.p95}  bias: ${sign(e.jump.signed)}`,
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
