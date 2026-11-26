import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLive } from "../../worker/src/bus-assets";
import { departures } from "../src/departures";
import { inspectTrip, networkActivity } from "../src/inspection";
import {
  type Release,
  type RouteTable,
  root,
  serviceZero,
  stopBucket,
} from "../src/schedule";

const date = "20261126";
const service = "m:holiday";
const key = `${date}/m/t`;
const start = serviceZero(date) + 12 * 3600000;
const release: Release = {
  schemaVersion: 1,
  networkVersion: "inspection",
  startDate: date,
  endDate: date,
  days: { [date]: [service] },
  maxSeconds: 90000,
  activityIndex: true,
  shapesUrls: [],
  stopsUrl: "",
};
const base = root(release.networkVersion);
const table: RouteTable = {
  feed: "m",
  routeId: "M42",
  routeName: "M42",
  patterns: [
    [
      ["a", 1, 0, 1],
      ["b", 2, 0, 0],
      ["a", 3, 0, 0],
      ["end", 4, 1, 0],
    ],
  ],
  offsets: [[0, 0, 300, 300, 600, 600, 900, 900]],
  trips: [["t", service, "East", 0, 0, 43200, "east"]],
};
const data: Record<string, unknown> = {
  [`${base}/services/m%3Aholiday.json`]: { t: ["M42", 44100] },
  [`${base}/routes/m-M42.json`]: table,
  [`${base}/activity/m%3Aholiday.json`]: [table],
};
for (const id of ["a", "b", "end"])
  data[`${base}/stops-${stopBucket(id)}.json`] = { [id]: ["m-M42"] };
const load = async <T>(p: string) => {
  assert.ok(Object.hasOwn(data, p), p);
  return data[p] as T;
};
test("trip detail honors the observed visit on a loop and can fall back to the timetable", async () => {
  const frame = emptyLive(release.networkVersion);
  const now = start + 120000;
  frame.feeds.vehiclePositions.timestamp = now;
  frame.positions = [
    {
      tripKey: key,
      vehicleId: "MTA NYCT_1234",
      nextStopId: "a",
      nextSequence: 3,
      observedAt: now,
      lat: 40.7,
      lon: -74,
    },
  ];
  const t = await inspectTrip(load, release, key, now, frame);
  assert.equal(t.vehicle?.vehicleId, "MTA NYCT_1234");
  assert.deepEqual(
    t.calls.map((c) => c.sequence),
    [3, 4],
  );
  assert.equal(t.headsign, "East");
  frame.positions = [];
  assert.deepEqual(
    (await inspectTrip(load, release, key, now, frame)).calls.map(
      (c) => c.sequence,
    ),
    [2, 3, 4],
  );
  await assert.rejects(
    inspectTrip(load, release, "20261125/m/t", now, frame),
    /unavailable/,
  );
});
test("map activity agrees with eligible departures through skipped stops, delays and cancellations", async () => {
  const frame = emptyLive(release.networkVersion);
  const now = start - 60000;
  async function check(expected: string[]) {
    const summary = await networkActivity(load, release, now, frame);
    assert.deepEqual(summary.stops.sort(), expected);
    assert.deepEqual(
      summary.shapes[`${base}/shapes-m.json`],
      expected.length ? ["east"] : [],
    );
    for (const id of ["a", "b", "end"]) {
      const rows = await departures(
        load,
        release,
        { stopId: id, after: now, until: summary.until, now },
        frame,
      );
      assert.equal(summary.stops.includes(id), rows.length > 0);
    }
  }
  await check(["a", "b"]);
  frame.feeds.tripUpdates.timestamp = now;
  frame.tripUpdates[key] = {
    observedAt: now,
    calls: [{ sequence: 2, relationship: 1 }],
  };
  await check(["a"]);
  assert.ok(
    !(await inspectTrip(load, release, key, now, frame)).calls.some(
      (c) => c.sequence === 2,
    ),
  );
  frame.tripUpdates[key] = { observedAt: now, calls: [], delay: 3600 };
  await check([]);
  frame.tripUpdates[key] = {
    observedAt: now,
    calls: [],
    canceledUntil: now + 86400000,
  };
  await check([]);
  assert.equal(
    (await inspectTrip(load, release, key, now, frame)).canceled,
    true,
  );
});
