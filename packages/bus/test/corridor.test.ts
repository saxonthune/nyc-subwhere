import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "../../contract/fixtures/bus-corridor-v1.json";
import worker from "../../worker/src/index";
import { root, serviceZero, stopBucket } from "../src/schedule";
const base = root(fixture.networkVersion);
const network = {
  schemaVersion: 1 as const,
  networkVersion: fixture.networkVersion,
  startDate: fixture.serviceDate,
  endDate: fixture.serviceDate,
  stopsUrl: `${base}/stops.json`,
  shapesUrls: [],
};
const table = structuredClone(fixture.table);
const assets: Record<string, unknown> = {
  "/bus-data/catalog.json": [network],
  [`${base}/release.json`]: {
    ...network,
    days: { [fixture.serviceDate]: ["m:weekday"] },
    maxSeconds: 90000,
  },
  [`${base}/stops-${stopBucket("curb")}.json`]: { curb: ["m-demo"] },
  [`${base}/routes/m-demo.json`]: table,
};
const env = {
  ASSETS: {
    async fetch(url: URL) {
      const value = assets[url.pathname];
      return value ? Response.json(value) : new Response(null, { status: 404 });
    },
  },
};
async function query(after: number, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    stopId: "curb",
    networkVersion: network.networkVersion,
    after: String(after),
    ...extra,
  });
  const response = await worker.fetch(
    new Request(`https://fixture/api/bus/departures?${params}`),
    env as never,
    {} as never,
  );
  assert.equal(response.status, 200);
  return response.json();
}
test("shared corridor through the production Worker router", async () => {
  const rows = (await query(fixture.curbArrival)).departures;
  assert.deepEqual(
    rows.map((r: { tripId: string }) => r.tripId),
    ["catch", "later"],
  );
  assert.equal(rows[0].tripKey, "20261123/m/catch");
  assert.deepEqual(rows[0].boarding, {
    stopId: "curb",
    sequence: 1,
    time: fixture.departure,
    basis: "scheduled",
  });
  assert.deepEqual(rows[0].downstream, [
    {
      stopId: "exit",
      sequence: 2,
      time: fixture.downstreamArrival,
      basis: "scheduled",
      canAlight: true,
    },
  ]);
  assert.equal((await query(fixture.departure)).departures[0].tripId, "catch");
  assert.equal(
    (await query(fixture.departure + 1)).departures[0].tripId,
    "later",
  );
});
test("equal-time pagination preserves both trip instances", async () => {
  table.trips.push(["second", "m:weekday", "Exit", 0, 0, 32040]);
  try {
    const first = await query(fixture.curbArrival, { limit: "1" });
    const second = await query(fixture.curbArrival, {
      limit: "1",
      cursor: first.nextCursor,
    });
    assert.equal(
      first.departures[0].boarding.time,
      second.departures[0].boarding.time,
    );
    assert.equal(second.departures[0].tripId, "second");
  } finally {
    table.trips.pop();
  }
});
test("Worker holds a published future release until cutover and serves the previous pin", async () => {
  const next = {
    ...network,
    networkVersion: "winter",
    startDate: "20261124",
    endDate: "20261231",
  };
  const catalog = assets["/bus-data/catalog.json"];
  assets["/bus-data/catalog.json"] = [network, next];
  try {
    const manifest = async (after: number, pin = "") => {
      const url = new URL("https://fixture/api/bus/network");
      url.searchParams.set("after", String(after));
      if (pin) url.searchParams.set("networkVersion", pin);
      const r = await worker.fetch(new Request(url), env as never, {} as never);
      assert.equal(r.status, 200);
      return (await r.json()).networkVersion;
    };
    const midnight = serviceZero("20261124");
    assert.equal(await manifest(midnight - 1), network.networkVersion);
    assert.equal(await manifest(midnight), "winter");
    assert.equal(
      await manifest(midnight, network.networkVersion),
      network.networkVersion,
    );
    assert.equal(
      (await query(fixture.curbArrival)).departures[0].tripId,
      "catch",
    );
  } finally {
    assets["/bus-data/catalog.json"] = catalog;
  }
});
test("GTFS noon anchor follows New York daylight saving transitions", () => {
  assert.equal(
    new Date(serviceZero("20260308") + 12 * 3600000).toISOString(),
    "2026-03-08T16:00:00.000Z",
  );
  assert.equal(
    new Date(serviceZero("20261101") + 12 * 3600000).toISOString(),
    "2026-11-01T17:00:00.000Z",
  );
});
