import { LitElement, css, html, nothing } from "lit";

// The inspector shows the raw contract data that drove what was clicked
// (doc01.03) — the source object(s) and their ids, not a friendly summary — so a
// developer can see exactly the data subset used to render that geometry. main.ts
// assembles `data` from the baked props + live snapshot; the panel just dumps it.
export interface InspectorTarget {
  kind: "segment" | "station" | "train";
  title: string;
  data: unknown;
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
        <pre class="body">${JSON.stringify(t.data, null, 2)}</pre>
      </div>
    `;
  }
}

customElements.define("inspector-panel", InspectorPanel);
