// FeedMessage -> RenderSnapshot (doc02.04). Decodes are done by the caller; this
// is the pure reshape: filter to live trains, normalize units, and express each
// Trip as lastKnownStop + upcoming for the web app to interpolate against.

import type {
  Direction,
  RenderSnapshot,
  StopArrival,
  TripState,
} from "@nyc-subwhere/contract";
import type { transit_realtime } from "./gtfs-proto.js";

// NyctTripDescriptor.Direction: NORTH=1, EAST=2, SOUTH=3, WEST=4.
const NORTH = 1;
const SOUTH = 3;

// Feed times are epoch *seconds* (protobuf int64, surfaced as number|Long);
// the contract is epoch milliseconds.
function toMs(time: unknown): number | null {
  if (time == null) return null;
  const n = Number(time);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

function directionOf(nyctDir: number | null | undefined, stopId: string): Direction {
  if (nyctDir === NORTH) return "N";
  if (nyctDir === SOUTH) return "S";
  return stopId.endsWith("S") ? "S" : "N"; // fall back to the stop_id suffix
}

export function buildSnapshot(
  msg: transit_realtime.FeedMessage,
  nowMs: number,
): RenderSnapshot {
  // Vehicle Positions live in their own entities; index by trip so a Trip Update
  // can find where its train currently is.
  const vehicleByTrip = new Map<
    string,
    transit_realtime.VehiclePosition.$Properties
  >();
  for (const e of msg.entity) {
    const tripId = e.vehicle?.trip?.tripId;
    if (e.vehicle && tripId) vehicleByTrip.set(tripId, e.vehicle);
  }

  const trips: TripState[] = [];
  for (const e of msg.entity) {
    const tu = e.tripUpdate;
    if (!tu?.trip) continue;

    const nyct = tu.trip[".nyctTripDescriptor"];
    if (!nyct?.isAssigned) continue; // live tracked trains only

    const tripId = tu.trip.tripId ?? nyct.trainId ?? "";
    const routeId = tu.trip.routeId ?? "";

    const arrivals: StopArrival[] = [];
    for (const s of tu.stopTimeUpdate ?? []) {
      if (!s.stopId) continue;
      const arrival = toMs(s.arrival?.time) ?? toMs(s.departure?.time);
      if (arrival == null) continue; // no usable keyframe time -> not renderable
      arrivals.push({ stopId: s.stopId, arrival, departure: toMs(s.departure?.time) });
    }
    if (arrivals.length === 0) continue;

    // v0 lastKnownStop: where the Vehicle Position says the train is, else the
    // first predicted stop. The true *departed* stop needs snapshot diffing
    // (doc02.04); this places the train at/approaching its current stop.
    const vehicle = vehicleByTrip.get(tripId);
    const currentStopId = vehicle?.stopId ?? arrivals[0].stopId;
    const at = toMs(vehicle?.timestamp) ?? nowMs;

    // upcoming = the stops ahead of the current one.
    const idx = arrivals.findIndex((a) => a.stopId === currentStopId);
    const upcoming = idx >= 0 ? arrivals.slice(idx + 1) : arrivals;
    if (upcoming.length === 0) continue; // nothing ahead to interpolate toward

    trips.push({
      tripId,
      routeId,
      direction: directionOf(nyct.direction, currentStopId),
      lastKnownStop: { stopId: currentStopId, at },
      upcoming,
    });
  }

  return { asOf: nowMs, trips };
}
