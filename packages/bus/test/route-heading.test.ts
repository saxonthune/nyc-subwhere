import assert from "node:assert/strict";
import { test } from "node:test";
import { routeHeading } from "../src/route-heading";

test("next visit resolves an overlapping return leg and follows the street through a corner", () => {
  // Go east, turn north, return south and then west along the same streets.
  const coords = Float64Array.of(
    -74,
    40.7,
    -73.999,
    40.7,
    -73.999,
    40.702,
    -73.999,
    40.7,
    -74,
    40.7,
  );
  const path: Parameters<typeof routeHeading>[1] = {
    shapeId: "loop",
    reverse: false,
    stops: [
      [1, "origin", 0],
      [2, "corner", 1],
      [3, "terminal", 2],
      [4, "corner", 3],
      [5, "origin", 4],
    ],
  };
  const vehicle = {
    position: {
      lat: 40.701,
      lon: -73.999,
      tripKey: "t",
      vehicleId: "v",
      observedAt: 0,
    },
    pathIndex: 0,
  };
  assert.equal(
    routeHeading(coords, path, { ...vehicle, stopId: "terminal" }),
    0,
  );
  assert.equal(
    routeHeading(coords, path, { ...vehicle, stopId: "corner", sequence: 4 }),
    180,
  );
  assert.equal(
    routeHeading(coords, path, { ...vehicle, stopId: "corner" }),
    undefined,
  );
  assert.equal(
    routeHeading(coords, path, {
      ...vehicle,
      position: { ...vehicle.position, lon: -73.98 },
    }),
    undefined,
  );
});

test("a delayed stop reference cannot hold the arrow on the street before a turn", () => {
  const geometry = Float64Array.of(-74, 40.7, -73.999, 40.7, -73.999, 40.702);
  const path = {
    shapeId: "turn",
    reverse: false,
    stops: [
      [1, "first", 0],
      [2, "corner", 1],
      [3, "last", 2],
    ],
  } satisfies Parameters<typeof routeHeading>[1];
  const position = {
    lon: -73.999,
    lat: 40.70025,
    tripKey: "t",
    vehicleId: "v",
    observedAt: 0,
  };
  assert.equal(
    routeHeading(geometry, path, { position, pathIndex: 0, stopId: "corner" }),
    0,
  );
});
