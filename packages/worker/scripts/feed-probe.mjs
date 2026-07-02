#!/usr/bin/env node
// Feed diagnostics for the NYCT GTFS-realtime endpoints — answers "what does the
// live feed actually carry" without ad-hoc scripts, so worker reshape decisions
// (doc02.04) rest on measured fields rather than assumptions. Run via
// `just feed-probe [feed]` (default: gtfs). Pass `all` to sweep every feed.
//
// Reports, per feed: assigned-trip count, VehiclePosition coverage, the
// currentStatus split (STOPPED_AT vs IN_TRANSIT_TO/INCOMING_AT — the share of
// trains whose reported stop is ahead of them, which the reshape must not treat
// as "behind"), whether the position carries lat/lon, arrival/departure coverage
// and dwell distribution, and whether the first predicted stop is already past.

import { transit_realtime } from "../src/gtfs-proto.js";

const FEED_BASE =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";
const ALL_FEEDS = [
  "gtfs",
  "gtfs-ace",
  "gtfs-bdfm",
  "gtfs-g",
  "gtfs-jz",
  "gtfs-nqrw",
  "gtfs-l",
  "gtfs-si",
];

const arg = process.argv[2] ?? "gtfs";
const feeds = arg === "all" ? ALL_FEEDS : [arg];

const pct = (xs, q) =>
  xs.length
    ? Math.round(
        xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)] / 1000,
      )
    : 0;

for (const feed of feeds) {
  const now = Date.now();
  const res = await fetch(`${FEED_BASE}${feed}`);
  if (!res.ok) {
    console.log(`\n## ${feed}: HTTP ${res.status} — skipped`);
    continue;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const msg = transit_realtime.FeedMessage.decode(buf);

  const vehByTrip = new Map();
  for (const e of msg.entity) {
    const t = e.vehicle?.trip?.tripId;
    if (e.vehicle && t) vehByTrip.set(t, e.vehicle);
  }

  let trips = 0;
  let withVeh = 0;
  let withLatLon = 0;
  const status = { 0: 0, 1: 0, 2: 0, none: 0 };
  const dwell = [];
  let firstPast = 0;
  let firstFuture = 0;
  let hasArrival = 0;
  let hasDeparture = 0;
  let stu = 0;

  for (const e of msg.entity) {
    const tu = e.tripUpdate;
    if (!tu?.trip) continue;
    const nyct = tu.trip[".nyctTripDescriptor"];
    if (!nyct?.isAssigned) continue;
    trips++;
    const tripId = tu.trip.tripId ?? nyct.trainId ?? "";
    const veh = vehByTrip.get(tripId);
    if (veh) {
      withVeh++;
      const cs = veh.currentStatus ?? "none";
      status[cs] = (status[cs] ?? 0) + 1;
      const p = veh.position;
      if (p && (p.latitude || p.longitude)) withLatLon++;
    }
    const stus = tu.stopTimeUpdate ?? [];
    for (const s of stus) {
      stu++;
      const a = s.arrival?.time != null ? Number(s.arrival.time) * 1000 : null;
      const d =
        s.departure?.time != null ? Number(s.departure.time) * 1000 : null;
      if (a != null) hasArrival++;
      if (d != null) hasDeparture++;
      if (a != null && d != null && d >= a) dwell.push(d - a);
    }
    const a0 =
      stus[0]?.arrival?.time != null
        ? Number(stus[0].arrival.time) * 1000
        : null;
    if (a0 != null) a0 < now ? firstPast++ : firstFuture++;
  }

  dwell.sort((a, b) => a - b);
  const share = (n) => (trips ? `${Math.round((100 * n) / trips)}%` : "0%");
  console.log(`\n## ${feed}  (entities=${msg.entity.length})`);
  console.log(`assigned trips: ${trips}`);
  console.log(
    `vehicle position: ${withVeh} (${share(withVeh)})  with lat/lon: ${withLatLon}`,
  );
  console.log(
    `currentStatus:  STOPPED_AT=${status[1]}  IN_TRANSIT_TO=${status[2]}  INCOMING_AT=${status[0]}  none=${status.none}`,
  );
  console.log(
    `  reported stop is AHEAD of train (in_transit + incoming): ${status[2] + status[0]} of ${withVeh}`,
  );
  console.log(
    `stopTimeUpdates: ${stu}  arrival=${hasArrival}  departure=${hasDeparture}`,
  );
  console.log(
    `dwell sec (departure-arrival): p50=${pct(dwell, 0.5)} p90=${pct(dwell, 0.9)} p99=${pct(dwell, 0.99)}  n=${dwell.length}`,
  );
  console.log(`first predicted stop: past=${firstPast} future=${firstFuture}`);
}
