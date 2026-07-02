// FeedMessage -> RenderSnapshot (doc02.04). Decodes are done by the caller; this
// reshapes: filter to live trains, normalize units, and express each Trip as
// lastKnownStop + upcoming for the web app to interpolate against.
//
// The feed gives no train coordinates (NYCT never populates VehiclePosition.
// position — see `just feed-probe`); the only position signal is a stopId plus a
// currentStatus saying whether the train is AT that stop or still approaching it.
// A majority are approaching, so the reported stop is usually *ahead* of the
// train, not behind it. Placing the anchor correctly therefore needs memory of
// where the train last was — the departed stop is recovered by diffing across
// polls, which is also what surfaces a stall (doc02.04). buildSnapshot takes a
// caller-owned TripMemory map so that state lives at the request boundary and the
// reshape stays a deterministic function of (feed, now, memory).

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

// VehiclePosition.VehicleStopStatus: INCOMING_AT=0, STOPPED_AT=1,
// IN_TRANSIT_TO=2. Anything other than STOPPED_AT means the reported stop is
// still ahead of the train.
const STOPPED_AT = 1;

// A trip is called stalled once it has been approaching the same stop for a
// while AND its predicted arrival has been pushed back by a comparable amount —
// the signature of a train not closing the gap, distinct from a long express run
// whose ETA holds steady. Both guards matter: the age gate rejects noise, the
// slip gate rejects legitimately long segments.
const STALL_MIN_APPROACH_MS = 45_000;
const STALL_SLIP_MS = 45_000;

export interface TripMem {
  atStopId: string | null; // last stop seen STOPPED_AT
  departedStopId: string | null; // stop the train has left (the back anchor)
  departedAt: number | null; // when we first saw it leave (poll-quantized)
  approachedStopId: string | null; // stop currently being approached
  approachedSince: number | null; // when this approach began
  approachedArrival: number | null; // last predicted arrival to it, for slip
  slipMs: number; // accumulated pushback of that arrival
}

export type TripMemory = Map<string, TripMem>;

// Feed times are epoch *seconds* (protobuf int64, surfaced as number|Long); the
// contract is epoch milliseconds.
function toMs(time: unknown): number | null {
  if (time == null) return null;
  const n = Number(time);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

function directionOf(
  nyctDir: number | null | undefined,
  stopId: string,
): Direction {
  if (nyctDir === NORTH) return "N";
  if (nyctDir === SOUTH) return "S";
  return stopId.endsWith("S") ? "S" : "N"; // fall back to the stop_id suffix
}

// `seen` collects every assigned tripId this call touched. The worker fans in
// across feeds into one shared memory, so it passes a shared set and prunes once
// after all feeds (pruneMemory); called without one, buildSnapshot prunes its
// own memory at the end (the standalone / test path).
export function buildSnapshot(
  msg: transit_realtime.FeedMessage,
  nowMs: number,
  memory: TripMemory = new Map(),
  sharedSeen?: Set<string>,
): RenderSnapshot {
  const seen = sharedSeen ?? new Set<string>();
  const prune = sharedSeen === undefined;
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
      arrivals.push({
        stopId: s.stopId,
        arrival,
        departure: toMs(s.departure?.time),
      });
    }
    if (arrivals.length === 0) continue;

    const vehicle = vehicleByTrip.get(tripId);
    // Without a vehicle we have only the predicted stops; the first is the next
    // one the train will reach, so treat it as being approached.
    const reportedStop = vehicle?.stopId ?? arrivals[0].stopId;
    const atStop = vehicle ? vehicle.currentStatus === STOPPED_AT : false;
    const arrivalOf = (stopId: string) =>
      arrivals.find((a) => a.stopId === stopId)?.arrival ?? null;

    const mem = memory.get(tripId) ?? freshMem();
    seen.add(tripId);

    let lastKnownStop: TripState["lastKnownStop"];
    let upcoming: StopArrival[];
    let status: TripState["status"];

    if (atStop) {
      // The train is at reportedStop now: anchor there and glide toward the
      // stops strictly ahead. Departed-stop memory is irrelevant while stopped.
      lastKnownStop = { stopId: reportedStop, at: nowMs };
      const idx = arrivals.findIndex((a) => a.stopId === reportedStop);
      upcoming = idx >= 0 ? arrivals.slice(idx + 1) : arrivals;
      mem.atStopId = reportedStop;
      mem.approachedStopId = null;
      mem.approachedSince = null;
      mem.approachedArrival = null;
      mem.slipMs = 0;
      status = "progressing";
    } else {
      // The train is approaching reportedStop, which is therefore ahead of it.
      if (mem.approachedStopId !== reportedStop) {
        // A fresh approach: the train has just left the stop it was parked at.
        mem.departedStopId = mem.atStopId;
        mem.departedAt = nowMs;
        mem.approachedStopId = reportedStop;
        mem.approachedSince = nowMs;
        mem.approachedArrival = arrivalOf(reportedStop);
        mem.slipMs = 0;
      } else {
        // Still approaching: accumulate any pushback of the predicted arrival.
        const arr = arrivalOf(reportedStop);
        if (arr != null && mem.approachedArrival != null) {
          mem.slipMs += arr - mem.approachedArrival;
        }
        if (arr != null) mem.approachedArrival = arr;
      }

      const approachAge = nowMs - (mem.approachedSince ?? nowMs);
      status =
        approachAge >= STALL_MIN_APPROACH_MS && mem.slipMs >= STALL_SLIP_MS
          ? "stalled"
          : "progressing";

      const idx = arrivals.findIndex((a) => a.stopId === reportedStop);
      if (mem.departedStopId != null && mem.departedAt != null) {
        // Anchor behind, at the departed stop, and interpolate into reportedStop
        // and beyond — the fix for the reported-stop-is-ahead misplacement.
        lastKnownStop = { stopId: mem.departedStopId, at: mem.departedAt };
        upcoming = idx >= 0 ? arrivals.slice(idx) : arrivals;
      } else {
        // First sighting mid-transit, no departed stop known: hold at the
        // approached stop until its predicted arrival rather than guess a
        // segment behind it. Self-corrects once we observe it stop somewhere.
        lastKnownStop = {
          stopId: reportedStop,
          at: arrivalOf(reportedStop) ?? nowMs,
        };
        upcoming = idx >= 0 ? arrivals.slice(idx + 1) : arrivals;
      }
    }

    memory.set(tripId, mem);
    if (upcoming.length === 0) continue; // nothing ahead to interpolate toward

    trips.push({
      tripId,
      routeId,
      direction: directionOf(nyct.direction, reportedStop),
      lastKnownStop,
      upcoming,
      status,
    });
  }

  if (prune) pruneMemory(memory, seen);

  return { asOf: nowMs, trips };
}

// Drop memory for trips absent from `seen` — the fan-in caller runs this once
// after every feed so a trip in feed B is not treated as gone while feed A is
// processed.
export function pruneMemory(memory: TripMemory, seen: Set<string>): void {
  for (const id of memory.keys()) if (!seen.has(id)) memory.delete(id);
}

function freshMem(): TripMem {
  return {
    atStopId: null,
    departedStopId: null,
    departedAt: null,
    approachedStopId: null,
    approachedSince: null,
    approachedArrival: null,
    slipMs: 0,
  };
}
