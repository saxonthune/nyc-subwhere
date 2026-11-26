import type { BusActivity, BusLive, BusTrip } from "../../contract/src/bus";
import { BusError, effectiveCalls, timingForTrip } from "./departures";
import {
  type LoadAsset,
  type Release,
  type RouteTable,
  fresh,
  root,
  serviceZero,
  tripKey,
} from "./schedule";

export async function inspectTrip(
  load: LoadAsset,
  release: Release,
  key: string,
  now: number,
  frame: BusLive,
): Promise<BusTrip> {
  const match = /^(\d{8})\/([a-z]+)\/(.+)$/.exec(key);
  if (!match) throw new BusError(400, "Invalid trip key");
  const [, date, feed, id] = match;
  const base = root(release.networkVersion);
  let route: string | undefined;
  const services = release.days[date] ?? [];
  for (const service of services.filter((s) => s.startsWith(`${feed}:`))) {
    const index = await load<Record<string, [string, number, number?]>>(
      `${base}/services/${encodeURIComponent(service)}.json`,
    );
    if (!Object.hasOwn(index, id)) continue;
    route = index[id][0];
    break;
  }
  if (!route)
    throw new BusError(404, "This trip is unavailable on this service date");
  const table = await load<RouteTable>(
    `${base}/routes/${feed}-${encodeURIComponent(route)}.json`,
  );
  const trip = table.trips.find((t) => t[0] === id && services.includes(t[1]));
  if (!trip) throw new BusError(404, "Unknown bus trip");
  const live =
    frame.networkVersion === release.networkVersion ? frame : undefined;
  const update = timingForTrip(live, key, now);
  const vehicle =
    live && fresh(live.feeds.vehiclePositions.timestamp, now)
      ? (live.positions.find(
          (p) => p.tripKey === key && fresh(p.observedAt, now),
        ) ?? null)
      : null;
  const result: BusTrip = {
    networkVersion: release.networkVersion,
    tripKey: key,
    serviceDate: date,
    routeName: table.routeName,
    headsign: trip[2],
    vehicle,
    canceled: update === "canceled",
    calls: [],
  };
  if (update === "canceled") return result;
  const calls = effectiveCalls(table, trip, serviceZero(date), update);
  const matchesNext = calls.filter(
    (c) =>
      (!vehicle?.nextStopId ||
        c.stopId === vehicle.nextStopId ||
        c.stopId === `${feed}:${vehicle.nextStopId}`) &&
      (vehicle?.nextSequence == null || c.sequence === vehicle.nextSequence),
  );
  const next =
    vehicle &&
    (vehicle.nextSequence != null || vehicle.nextStopId) &&
    matchesNext.length === 1
      ? matchesNext[0]
      : undefined;
  result.calls = calls
    .filter(
      (c) =>
        !c.skipped &&
        (next ? c.sequence >= next.sequence : c.departure.time >= now),
    )
    .map((c) => ({
      stopId: c.stopId,
      sequence: c.sequence,
      canAlight: c.canAlight,
      ...c.arrival,
    }));
  return result;
}

export async function networkActivity(
  load: LoadAsset,
  release: Release,
  after: number,
  frame: BusLive,
): Promise<BusActivity> {
  if (!release.activityIndex)
    throw new BusError(503, "No activity index for this release");
  const until = after + 3600000;
  const stops = new Set<string>();
  const shapes = new Map<string, Set<string>>();
  const live =
    frame.networkVersion === release.networkVersion ? frame : undefined;
  // Include an unusually late trip if its real-time update still belongs to an older service day.
  const liveDates = new Set(
    Object.keys(live?.tripUpdates ?? {}).map((k) => k.slice(0, 8)),
  );
  for (const [date, services] of Object.entries(release.days)) {
    const zero = serviceZero(date);
    if (
      zero >= until ||
      (zero + release.maxSeconds * 1000 < after && !liveDates.has(date))
    )
      continue;
    for (const service of services) {
      const tables = await load<RouteTable[]>(
        `${root(release.networkVersion)}/activity/${encodeURIComponent(service)}.json`,
      );
      for (const table of tables) {
        let active = shapes.get(table.feed);
        if (!active) {
          active = new Set();
          shapes.set(table.feed, active);
        }
        for (const trip of table.trips) {
          const update = timingForTrip(
            live,
            tripKey(table.feed, trip[0], date),
            after,
          );
          if (update === "canceled") continue;
          const start = zero + trip[5] * 1000;
          const offsets = table.offsets[trip[4]];
          if (
            !update &&
            (start >= until ||
              start + offsets[offsets.length - 1] * 1000 < after)
          )
            continue;
          const calls = effectiveCalls(table, trip, zero, update);
          // A boarding needs a later alightable call, just as in the curb query.
          let onward = false;
          for (let i = calls.length - 1; i >= 0; i--) {
            const call = calls[i];
            if (
              onward &&
              call.canBoard &&
              call.departure.time >= after &&
              call.departure.time < until
            ) {
              stops.add(call.stopId);
              if (trip[6]) active.add(trip[6]);
            }
            onward ||= call.canAlight;
          }
        }
      }
    }
  }
  return {
    networkVersion: release.networkVersion,
    after,
    until,
    stops: [...stops],
    shapes: Object.fromEntries(
      [...shapes].map(([feed, ids]) => [
        `${root(release.networkVersion)}/shapes-${feed}.json`,
        [...ids],
      ]),
    ),
  };
}
