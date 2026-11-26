import type {
  BusDeparture,
  BusEvent,
  BusLive,
  BusPrediction,
  BusUpdate,
} from "../../contract/src/bus";
import {
  type LoadAsset,
  type Release,
  type RouteTable,
  fresh,
  root,
  serviceZero,
  stopBucket,
  tripKey,
} from "./schedule";

export function effectiveCalls(
  table: RouteTable,
  trip: RouteTable["trips"][number],
  zero: number,
  update: BusUpdate | undefined,
) {
  const visits = table.patterns[trip[3]];
  const offsets = table.offsets[trip[4]];
  const bySequence = new Map<number, BusPrediction>();
  for (const p of update?.calls ?? []) {
    if (p.sequence !== undefined) {
      bySequence.set(p.sequence, p);
      continue;
    }
    const matches = visits.filter(
      (v) => v[0] === p.stopId || v[0] === `${table.feed}:${p.stopId}`,
    );
    if (matches.length === 1) bySequence.set(matches[0][1], p);
  }
  let delay = update?.delay;
  return visits.map(([stopId, sequence, pickup, dropoff], i) => {
    const prediction = bySequence.get(sequence);
    const p =
      prediction &&
      (!prediction.stopId ||
        prediction.stopId === stopId ||
        `${table.feed}:${prediction.stopId}` === stopId)
        ? prediction
        : undefined;
    if (p?.relationship === 2) delay = undefined; // NO_DATA ends propagation.
    function event(offset: number, time?: number, seconds?: number): BusEvent {
      const scheduled = zero + (trip[5] + offset) * 1000;
      if (time !== undefined) delay = (time - scheduled) / 1000;
      else if (seconds !== undefined) delay = seconds;
      return delay === undefined
        ? { time: scheduled, basis: "scheduled" }
        : {
            time: scheduled + delay * 1000,
            basis: "predicted",
            observedAt: update?.observedAt,
          };
    }
    const arrival = event(offsets[2 * i], p?.arrival, p?.arrivalDelay);
    const departure = event(
      offsets[2 * i + 1],
      p?.departure,
      p?.departureDelay,
    );
    return {
      stopId,
      sequence,
      arrival,
      departure,
      skipped: p?.relationship === 1,
      canBoard: pickup === 0 && p?.relationship !== 1,
      canAlight: dropoff === 0 && p?.relationship !== 1,
    };
  });
}
// Cancellation outlives prediction freshness. All timetable consumers apply the
// same rule, including when only one of the realtime feeds is available.
export function timingForTrip(
  frame: BusLive | undefined,
  key: string,
  now: number,
) {
  const observation = frame?.tripUpdates[key];
  if (observation?.canceledUntil && observation.canceledUntil >= now)
    return "canceled";
  if (
    observation &&
    fresh(frame?.feeds.tripUpdates.timestamp ?? null, now) &&
    fresh(observation.observedAt, now)
  )
    return observation;
  return undefined;
}
export class BusError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Query {
  stopId: string;
  after: number;
  until: number;
  now: number;
  offset?: number;
  count?: number;
}
interface Candidate {
  table: RouteTable;
  trip: RouteTable["trips"][number];
  key: string;
  date: string;
  zero: number;
  index: number;
  sequence: number;
  time: number;
  update?: BusUpdate;
}
export async function departures(
  load: LoadAsset,
  release: Release,
  q: Query,
  live?: BusLive,
): Promise<BusDeparture[]> {
  const base = root(release.networkVersion);
  const stops = await load<Record<string, string[]>>(
    `${base}/stops-${stopBucket(q.stopId)}.json`,
  );
  if (!Object.hasOwn(stops, q.stopId))
    throw new BusError(404, "Unknown bus stop");
  const dates = Object.entries(release.days)
    .filter(([date]) => {
      const zero = serviceZero(date);
      return (
        zero <= q.until && zero + (release.maxSeconds + 86400) * 1000 >= q.after
      );
    })
    .map(([date, ids]) => ({
      date,
      services: new Set(ids),
      zero: serviceZero(date),
    }));
  const frame =
    live?.networkVersion === release.networkVersion ? live : undefined;
  const result: Candidate[] = [];
  for (const file of stops[q.stopId]) {
    const table = await load<RouteTable>(`${base}/routes/${file}.json`);
    const indices = table.patterns.map((visits) =>
      visits.flatMap((v, i) =>
        v[0] === q.stopId &&
        v[2] === 0 &&
        visits.slice(i + 1).some((next) => next[3] === 0)
          ? [i]
          : [],
      ),
    );
    for (const { date, services, zero } of dates) {
      for (const trip of table.trips) {
        if (!services.has(trip[1]) || !indices[trip[3]].length) continue;
        const key = tripKey(table.feed, trip[0], date);
        const update = timingForTrip(frame, key, q.now);
        if (update === "canceled") continue;
        const offsets = table.offsets[trip[4]];
        for (const i of indices[trip[3]]) {
          const scheduled = zero + (trip[5] + offsets[i * 2 + 1]) * 1000;
          let time = scheduled;
          if (update) {
            const calls = effectiveCalls(table, trip, zero, update);
            if (
              !calls[i].canBoard ||
              !calls.slice(i + 1).some((c) => c.canAlight)
            )
              continue;
            time = calls[i].departure.time;
          }
          if (time < q.after || time >= q.until) continue;
          result.push({
            table,
            trip,
            key,
            date,
            zero,
            index: i,
            sequence: table.patterns[trip[3]][i][1],
            time,
            update,
          });
        }
      }
    }
  }
  result.sort(
    (a, b) =>
      a.time - b.time ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      a.sequence - b.sequence,
  );
  const offset = q.offset ?? 0;
  return result
    .slice(offset, q.count === undefined ? undefined : offset + q.count)
    .map(({ table, trip, key, date, zero, index, update }) => {
      const calls = effectiveCalls(table, trip, zero, update);
      const board = calls[index];
      const downstream = calls.slice(index + 1).map((c) => ({
        stopId: c.stopId,
        sequence: c.sequence,
        canAlight: c.canAlight,
        ...c.arrival,
      }));
      return {
        feed: table.feed,
        routeId: table.routeId,
        routeName: table.routeName,
        tripId: trip[0],
        tripKey: key,
        serviceDate: date,
        headsign: trip[2],
        boarding: {
          stopId: q.stopId,
          sequence: board.sequence,
          ...board.departure,
        },
        downstream,
      };
    });
}
