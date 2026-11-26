import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../../contract/fixtures/bus-corridor-v1.json";
import { pollBuses, visibleFrame } from "../../worker/src/bus-live";
import { transit_realtime as rt } from "../../worker/src/gtfs-proto.js";
import { departures } from "../src/departures";
import {
  type Release,
  type RouteTable,
  root,
  serviceZero,
  stopBucket,
} from "../src/schedule";

const {
  curbArrival: now,
  serviceDate: date,
  networkVersion: version,
} = fixture;
const release: Release = {
  schemaVersion: 1,
  networkVersion: version,
  startDate: date,
  endDate: "20261124",
  stopsUrl: "",
  shapesUrls: [],
  days: { [date]: ["m:weekday"], "20261124": [] },
  maxSeconds: 90000,
};
const table: RouteTable = {
  ...fixture.table,
  patterns: [
    [
      ["curb", 1, 0, 1],
      ["exit", 2, 1, 0],
      ["curb", 5, 1, 0],
    ],
  ],
  trips: fixture.table.trips as RouteTable["trips"],
  offsets: [[0, 0, 300, 300, 600, 600]],
};
const data: Record<string, unknown> = {
  [`${root(version)}/services/m%3Aweekday.json`]: Object.fromEntries(
    table.trips.map((t) => [t[0], ["demo", t[5] + 600]]),
  ),
  [`${root(version)}/stops-${stopBucket("curb")}.json`]: {
    curb: ["m-demo"],
  },
  [`${root(version)}/routes/m-demo.json`]: table,
};
const load = async <T>(p: string) => {
  assert.ok(data[p], p);
  return data[p] as T;
};
const delayAt = now + 60000;
const descriptor = (tripId: string) => ({
  tripId,
  startDate: date,
  routeId: "demo",
});
function message(entity: unknown[], time = now) {
  return rt.FeedMessage.encode(
    rt.FeedMessage.fromObject({
      header: { gtfsRealtimeVersion: "2.0", timestamp: time / 1000 },
      entity,
    }),
  ).finish();
}
const updates = message([
  {
    id: "1",
    tripUpdate: {
      trip: descriptor("early"),
      timestamp: now / 1000,
      stopTimeUpdate: [
        {
          stopId: "curb",
          stopSequence: 1,
          departure: { time: delayAt / 1000 },
        },
        { stopId: "exit", stopSequence: 2, scheduleRelationship: 1 },
      ],
    },
  },
  {
    id: "2",
    tripUpdate: { trip: { ...descriptor("catch"), scheduleRelationship: 3 } },
  },
  { id: "3", tripUpdate: { trip: descriptor("unmatched") } },
]);
const vehicles = message([
  {
    id: "bus",
    vehicle: {
      trip: descriptor("early"),
      vehicle: { id: "vehicle" },
      position: { latitude: 40.7, longitude: -74 },
      timestamp: now / 1000,
    },
  },
]);
test("wire replay reconciles live and scheduled calls, preserves valid cancellations across failures", async () => {
  const frame = await pollBuses(
    release,
    load,
    async (kind) => (kind === "tripUpdates" ? updates : vehicles),
    now,
  );
  assert.equal(frame.feeds.tripUpdates.matched, 2);
  assert.equal(frame.feeds.tripUpdates.unmatched, 1);
  assert.equal(visibleFrame(frame, now).positions.length, 1);
  const q = { stopId: "curb", after: now, until: now + 3600000, now };
  const rows = await departures(load, release, q, frame);
  assert.deepEqual(
    rows.map((r) => r.tripId),
    ["early", "later"],
  );
  assert.deepEqual(rows[0].boarding, {
    time: delayAt,
    basis: "predicted",
    observedAt: now,
    stopId: "curb",
    sequence: 1,
  });
  assert.deepEqual(
    rows[0].downstream.map((v) => [v.stopId, v.sequence, v.canAlight]),
    [
      ["exit", 2, false],
      ["curb", 5, true],
    ],
  );
  const outage = await pollBuses(
    release,
    load,
    async () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
    now + 180000,
    frame,
  );
  const stale = visibleFrame(outage, now + 180000);
  assert.equal(stale.positions.length, 0);
  assert.equal(stale.feeds.tripUpdates.lastSuccess, now);
  assert.deepEqual(
    (await departures(load, release, { ...q, now: now + 180000 }, stale)).map(
      (r) => r.tripId,
    ),
    ["later"],
  );
  const empty = await pollBuses(
    release,
    load,
    async () => message([], now + 180000),
    now + 180000,
    outage,
  );
  assert.ok(empty.tripUpdates[`${date}/m/catch`].canceledUntil);
  assert.equal(
    Object.keys(visibleFrame(empty, now + 3600000).tripUpdates).length,
    0,
  );
  const other = { ...frame, networkVersion: "another-release" };
  assert.deepEqual(
    (await departures(load, release, q, other)).map((r) => r.tripId),
    ["catch", "later"],
  );
});
test("closed service day still serves previous day's after-midnight trip by service date", async () => {
  const night: RouteTable = {
    ...table,
    trips: [["overnight", "m:weekday", "Exit", 0, 0, 25 * 3600]],
  };
  const nightLoad = async <T>(p: string) =>
    p.endsWith("/m-demo.json") ? (night as T) : load<T>(p);
  const at = serviceZero("20261124") + 3600000;
  const found = await departures(nightLoad, release, {
    stopId: "curb",
    after: at,
    until: at + 3600000,
    now: at,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].serviceDate, date);
  assert.equal(found[0].boarding.time, at);
  assert.deepEqual(
    await departures(nightLoad, release, {
      stopId: "curb",
      after: at + 1,
      until: at + 3600000,
      now: at,
    }),
    [],
  );
});
