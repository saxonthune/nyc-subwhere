import { LitElement, css, html } from "lit";

// Top-left title panel matching the network's dark Tron chrome (doc01.03). Purely
// a label — no interaction — so it sits above the map at a fixed corner.
export class HeaderPanel extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      left: 16px;
      top: 16px;
      z-index: 10;
      font: 600 18px/1 system-ui, sans-serif;
    }
    .label {
      display: inline-block;
      color: #e8e8e8;
      background: rgba(18, 18, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      padding: 10px 14px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      user-select: none;
    }
  `;

  render() {
    return html`<span class="label">SubWhere?</span>`;
  }
}

customElements.define("header-panel", HeaderPanel);
