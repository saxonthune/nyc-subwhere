import type {
  BusCurb,
  BusDeparture,
  BusDepartures,
  BusEvent,
  BusPosition,
  BusTrip,
} from "@nyc-subwhere/contract";
import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";

import { recenterIcon } from "./icons";

const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});
const busName = (v: BusPosition) =>
  `Bus ${v.vehicleId.replace(/^(?:MTA NYCT|MTABC)_/, "")}`;
const eventTime = (e: BusEvent) =>
  html`<time datetime=${new Date(e.time).toISOString()}>${clock.format(e.time)}</time> <small>${e.basis}</small>`;
const serviceDay = (s: string) =>
  `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;

export class BusPanel extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      right: 16px;
      bottom: 72px;
      z-index: 9;
      width: min(360px,calc(100vw - 32px));
      font: 15px/1.4 system-ui,sans-serif;
      color: #f7f9fe;
    }
    section {
      background: #263950;
      padding: 12px 14px;
      border-radius: 10px;
      box-shadow: 0 8px 28px #0008;
      max-height: 55dvh;
      overflow: auto;
    }
    header,.visit,.when {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    h2 {
      font-size: 17px;
      margin: 0;
    }
    p {
      margin: 6px 0;
    }
    h3 {
      margin: 8px 0 0;
      color: #d8e1eb;
      font-size: 13px;
      font-weight: 600;
    }
    .visit>span:last-child {
      margin-left: auto;
    }
    .visit::after {
      content: "";
      width: 5px;
      height: 5px;
      flex: none;
      border-top: 2px solid #a4c1d4;
      border-right: 2px solid #a4c1d4;
      transform: rotate(45deg);
      align-self: center;
    }
    button {
      font: inherit;
      color: inherit;
      cursor: pointer;
      border: 0;
    }
    .action {
      background: #416080;
      border-radius: 5px;
      padding: 5px 9px;
      font-size: 13px;
    }
    header { align-items:center; }
    .actions { display:flex; flex:none; align-items:center; gap:6px; }
    .actions .action { min-height:32px; }
    .recenter { width:32px; padding:0; display:grid; place-items:center; }
    .recenter:disabled { opacity:0.55; cursor:default; }
    .list {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      overflow: auto;
      max-height: min(260px,34dvh);
      overscroll-behavior: contain;
      scrollbar-width: thin;
    }
    .list>li {
      border-top: 1px solid #53667b;
    }
    .link {
      display: block;
      box-sizing: border-box;
      width: 100%;
      background: transparent;
      text-align: left;
      padding: 7px 3px;
    }
    .link:hover,summary:hover {
      background: #374d63;
    }
    button:focus-visible,summary:focus-visible {
      outline: 2px solid #8af6f0;
      outline-offset: -2px;
    }
    .route {
      color: #8af6f0;
    }
    small,.meta {
      color: #c4d6e6;
      font-size: 12px;
    }
    .when span:last-child,.visit span:last-child {
      flex-shrink: 0;
    }
    time {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    details {
      font-size: 13px;
      padding: 0 3px 5px;
    }
    summary {
      cursor: pointer;
      color: #cfdeed;
    }
    ol {
      padding-left: 18px;
      margin: 3px 0;
    }
    .more {
      margin-top: 6px;
    }
  `;
  curb?: BusCurb;
  tripKey?: string;
  trip?: BusTrip;
  rows?: BusDepartures;
  status = "";
  names = new Map<string, BusCurb>();
  vehicles = new Map<string, BusPosition>();
  onClose = () => {};
  onCenter = (_point: BusCurb | BusPosition) => {};
  onStop = (_id: string) => {};
  onTrip = (_key: string) => {};
  onMore = () => {};
  private call(c: BusDeparture["downstream"][number]) {
    return html`<li data-stop-id=${c.stopId} data-sequence=${c.sequence}><button class="link" @click=${() => this.onStop(c.stopId)}><span class="visit"><span>${this.names.get(c.stopId)?.name ?? c.stopId}</span><span>${eventTime(c)}</span></span>${c.canAlight ? nothing : html`<small>Alighting unavailable</small>`}</button></li>`;
  }
  private departure(row: BusDeparture) {
    const vehicle = this.vehicles.get(row.tripKey);
    return html`<li data-trip-key=${row.tripKey} data-service-date=${row.serviceDate}>
      <button class="link trip-link" @click=${() => this.onTrip(row.tripKey)}>
        <strong class="route">${row.routeName}</strong> ${row.headsign}
        <span class="when"><span>${eventTime(row.boarding)}</span>${vehicle ? html`<small>${busName(vehicle)}</small>` : nothing}</span>
      </button>
      <details><summary>Downstream stops</summary><p class="meta">Service date ${serviceDay(row.serviceDate)}</p>
      ${row.boarding.observedAt ? html`<p class="meta">Prediction updated ${clock.format(row.boarding.observedAt)}</p>` : nothing}
      <ol>${row.downstream.map((c) => this.call(c))}</ol></details>
    </li>`;
  }
  render() {
    if (!this.curb && !this.tripKey && !this.status) return nothing;
    const trip = this.trip;
    const vehicle = this.tripKey
      ? (this.vehicles.get(this.tripKey) ?? trip?.vehicle)
      : null;
    const title =
      this.curb?.name ??
      (vehicle
        ? busName(vehicle)
        : trip
          ? `${trip.routeName} trip`
          : "Bus details");
    const target =
      this.curb ?? (this.tripKey ? this.vehicles.get(this.tripKey) : undefined);
    const centerLabel = this.curb ? "Center bus stop" : "Center bus";
    return html`<section aria-label="Bus details">
    <header><h2>${title}</h2><div class="actions">
      ${
        this.curb || this.tripKey
          ? html`<button class="action recenter" aria-label=${centerLabel}
        title=${target ? centerLabel : "No live bus position"} ?disabled=${!target}
        @click=${() => {
          if (target) this.onCenter(target);
        }}>${recenterIcon}</button>`
          : nothing
      }
      <button class="action" @click=${this.onClose} aria-label="Close bus details">Close</button>
    </div></header>
    ${this.status ? html`<p role="status">${this.status}</p>` : nothing}
    ${
      trip
        ? html`<p><strong class="route">${trip.routeName}</strong> ${trip.headsign}</p>
      <p class="meta">${vehicle ? `Last seen ${clock.format(vehicle.observedAt)}` : `No live position for this trip on ${serviceDay(trip.serviceDate)}`}</p>
      ${
        trip.canceled
          ? html`<p>Trip canceled</p>`
          : trip.calls.length
            ? html`<h3>Upcoming stops</h3><ul class="list" aria-label="Upcoming stops">${repeat(
                trip.calls,
                (c) => c.sequence,
                (c) => this.call(c),
              )}</ul>`
            : html`<p>No upcoming stops</p>`
      }`
        : nothing
    }
    ${
      this.rows?.departures.length
        ? html`<h3>Departures in the next hour</h3><ul class="list" aria-label="Departures">${repeat(
            this.rows.departures,
            (r) => `${r.tripKey}/${r.boarding.sequence}`,
            (r) => this.departure(r),
          )}</ul>`
        : nothing
    }
    ${this.rows?.nextCursor ? html`<button class="more action" @click=${this.onMore}>More departures</button>` : nothing}</section>`;
  }
}
customElements.define("bus-panel", BusPanel);
