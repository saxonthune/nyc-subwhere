// FeedMessage -> RenderSnapshot (doc02.04), reshaped around observed motion
// (doc02.06). The feed gives one hard positional fact per poll — at `timestamp`
// the train is {at|approaching} `stopId`, with no coordinate (NYCT never
// populates VehiclePosition.position; see `just feed-probe`) — plus predicted
// arrival times whose tails are volatile. So position is recovered by:
//   * treating an advance of the referenced stop as an OBSERVED pass event, and
//     anchoring the train's rear at that stop, timed to the middle of the poll
//     window in which the pass must have happened (not the detecting poll, which
//     runs ~½ poll late);
//   * COMMITTING the predicted arrival to the stop ahead at the moment of
//     departure and dead-reckoning against that frozen time, so mid-segment ETA
//     jitter does not move the train;
//   * refusing to render past the last observation: if the committed arrival
//     passes with no observed arrival, the train is stalled somewhere on the
//     segment — hold it at the next stop and let the Board blink it, rather than
//     assert an arrival never seen.
// State lives at the request boundary (a caller-owned TripMemory), so the reshape
// stays a deterministic function of (feed, now, memory).

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

// Fallback half-window when we have no prior sighting to size the poll gap from.
const HALF_POLL_MS = 15_000;

// A committed arrival overrun by more than this with no observed arrival means
// the train is stuck on the segment, not merely a little slow (doc02.06).
const STALL_GRACE_MS = 45_000;

export interface TripMem {
  frontStopId: string | null; // stop last referenced (at, or being approached)
  departedStopId: string | null; // stop the train was last observed to leave
  departedAt: number | null; // t_leftA, the observed departure (window midpoint)
  committedArrival: number | null; // t_reachB, frozen when the segment began
  lastSeenAt: number | null; // previous poll time for this trip, to size the gap
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
    const front = vehicle?.stopId ?? arrivals[0].stopId;
    const atStop = vehicle ? vehicle.currentStatus === STOPPED_AT : false;
    const frontIdx = arrivals.findIndex((a) => a.stopId === front);
    const arrivalOfFront =
      frontIdx >= 0
        ? arrivals[frontIdx].arrival
        : (arrivalOf(arrivals, front) ?? nowMs);

    const mem = memory.get(tripId) ?? freshMem();
    seen.add(tripId);

    // An advance of the referenced stop is an observed pass event: the train has
    // left its previous front. Anchor the departure at the middle of the window
    // it must have happened in, and freeze the arrival to the new front.
    if (front !== mem.frontStopId) {
      const gap =
        mem.lastSeenAt != null ? nowMs - mem.lastSeenAt : 2 * HALF_POLL_MS;
      mem.departedStopId = mem.frontStopId;
      mem.departedAt = nowMs - gap / 2;
      mem.committedArrival = arrivalOfFront;
      mem.frontStopId = front;
    }
    mem.lastSeenAt = nowMs;
    memory.set(tripId, mem);

    let lastKnownStop: TripState["lastKnownStop"];
    let upcoming: StopArrival[];
    let status: TripState["status"] = "progressing";

    if (atStop) {
      // Observed AT the front stop: anchor there, glide toward the stops ahead.
      lastKnownStop = { stopId: front, at: nowMs };
      upcoming = frontIdx >= 0 ? arrivals.slice(frontIdx + 1) : arrivals;
    } else if (mem.departedStopId != null && mem.departedAt != null) {
      // Approaching the front from a known departed stop: dead-reckon the
      // committed segment (departed -> front at the frozen arrival), then hand
      // the live predictions beyond it as runway.
      lastKnownStop = { stopId: mem.departedStopId, at: mem.departedAt };
      const committed: StopArrival = {
        stopId: front,
        arrival: mem.committedArrival ?? arrivalOfFront,
        departure: frontIdx >= 0 ? arrivals[frontIdx].departure : null,
      };
      const beyond = frontIdx >= 0 ? arrivals.slice(frontIdx + 1) : [];
      const overran =
        mem.committedArrival != null &&
        nowMs > mem.committedArrival + STALL_GRACE_MS;
      if (overran) {
        // Committed arrival passed with no observed arrival -> stuck on the
        // segment. Truncate the runway at the front so the Board holds it there
        // and blinks, instead of gliding onto stops it has not reached.
        upcoming = [committed];
        status = "stalled";
      } else {
        upcoming = [committed, ...beyond];
      }
    } else {
      // First sighting mid-transit, no departed stop known: hold at the front
      // until its arrival rather than guess a segment behind it. Self-corrects
      // once the train is observed to pass a stop.
      lastKnownStop = {
        stopId: front,
        at: mem.committedArrival ?? arrivalOfFront,
      };
      upcoming = frontIdx >= 0 ? arrivals.slice(frontIdx + 1) : arrivals;
    }

    if (upcoming.length === 0) continue; // nothing ahead to interpolate toward

    trips.push({
      tripId,
      routeId,
      direction: directionOf(nyct.direction, front),
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

function arrivalOf(arrivals: StopArrival[], stopId: string): number | null {
  return arrivals.find((a) => a.stopId === stopId)?.arrival ?? null;
}

function freshMem(): TripMem {
  return {
    frontStopId: null,
    departedStopId: null,
    departedAt: null,
    committedArrival: null,
    lastSeenAt: null,
  };
}
