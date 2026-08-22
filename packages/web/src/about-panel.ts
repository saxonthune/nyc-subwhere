import { LitElement, css, html, nothing } from "lit";

// About modal from the Menu: names the project's data sources and carries the
// attribution their licenses ask for — notably OpenStreetMap's, whose ODbL
// requires credit visible to viewers of the derived map (the street grid).
export class AboutPanel extends LitElement {
  static properties = { open: { attribute: false, type: Boolean } };
  declare open: boolean;

  constructor() {
    super();
    this.open = false;
  }

  static styles = css`
    :host {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      z-index: 10;
      font: 14px/1.5 system-ui, sans-serif;
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
    .body {
      padding: 10px 12px;
    }
    p {
      margin: 0 0 8px;
    }
    p:last-child {
      margin-bottom: 0;
    }
    a {
      color: #8cbeff;
    }
  `;

  render() {
    if (!this.open) return nothing;
    return html`
      <div class="panel">
        <header>
          <span class="title">About</span>
          <button
            class="close"
            @click=${() => {
              this.open = false;
            }}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div class="body">
          <p>
            © 2026 Saxon Thune ·
            <a
              href="https://github.com/saxonthune/nyc-subwhere"
              target="_blank"
              >Source on GitHub</a
            >
            ·
            <a href="https://saxon.zone" target="_blank">saxon.zone</a>
          </p>
          <p>
            Subway data from the
            <a href="https://www.mta.info/developers" target="_blank"
              >MTA</a
            >. Independent project, not affiliated with or endorsed by the MTA.
          </p>
          <p>
            Street grid ©
            <a href="https://www.openstreetmap.org/copyright" target="_blank"
              >OpenStreetMap</a
            >
            contributors (ODbL), via a
            <a href="https://download.bbbike.org/osm/" target="_blank"
              >BBBike</a
            >
            extract.
          </p>
          <p>
            Citi Bike station data from the
            <a href="https://citibikenyc.com/system-data" target="_blank"
              >Citi Bike system data</a
            >
            feeds (Lyft). Borough boundaries from
            <a href="https://opendata.cityofnewyork.us/" target="_blank"
              >NYC Open Data</a
            >.
          </p>
          <p>
            Icons by
            <a href="https://fontawesome.com" target="_blank"
              >Font Awesome Free</a
            >
            (<a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              >CC BY 4.0</a
            >).
          </p>
        </div>
      </div>
    `;
  }
}

customElements.define("about-panel", AboutPanel);
