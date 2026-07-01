import { LitElement, css, html, nothing } from "lit";

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
  };
  declare options: MenuOption[];
  declare open: boolean;

  constructor() {
    super();
    this.options = [];
    this.open = false;
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
  `;

  private toggle() {
    this.open = !this.open;
  }

  render() {
    return html`
      ${
        this.open
          ? html`<div class="panel">
            ${this.options.map(
              (o) => html`<button @click=${o.onSelect}>${o.label}</button>`,
            )}
          </div>`
          : nothing
      }
      <button class="toggle" @click=${this.toggle}>Menu</button>
    `;
  }
}

customElements.define("menu-panel", Menu);
