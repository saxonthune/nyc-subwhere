// Verify a real stop selection against the Worker serving this build.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:8798";
const stopId = process.argv[3] ?? "404160";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
// Pan away first. Both buttons must bring the target back into the open map
// without closing its inspector or resetting the camera zoom and rotation.
async function verifyRecenter(page, label, target) {
  const button = page.getByRole("button", { name: label, exact: true });
  const close = page.getByRole("button", { name: "Close bus details" });
  const icon = await button.boundingBox();
  const closeBox = await close.boundingBox();
  assert.ok(
    icon &&
      closeBox &&
      icon.x + icon.width <= closeBox.x &&
      Math.abs(icon.y - closeBox.y) < 3,
  );
  await page.evaluate(() => window.__map.panBy([100, 90], { duration: 0 }));
  const box = await page.locator("bus-panel section").boundingBox();
  const { width, height } = page.viewportSize();
  const leftArea = box.x * height;
  const upperArea = box.y * width;
  const expected =
    leftArea > upperArea ? [box.x / 2, height / 2] : [width / 2, box.y / 2];
  const coords =
    typeof target === "string"
      ? await page.evaluate(
          (key) =>
            window.__map
              .getSource("bus-vehicles")
              .serialize()
              .data.features.find((f) => f.properties.tripKey === key).geometry
              .coordinates,
          target,
        )
      : target;
  const before = await page.evaluate(() => [
    window.__map.getZoom(),
    window.__map.getPitch(),
    window.__map.getBearing(),
  ]);
  await button.click();
  await page.waitForFunction(
    ({ coords, expected }) => {
      const p = window.__map.project(coords);
      return Math.abs(p.x - expected[0]) < 4 && Math.abs(p.y - expected[1]) < 4;
    },
    { coords, expected },
    { timeout: 8000 },
  );
  assert.deepEqual(
    await page.evaluate(() => [
      window.__map.getZoom(),
      window.__map.getPitch(),
      window.__map.getBearing(),
    ]),
    before,
  );
  console.log(label, "verified at", expected.map(Math.round));
}
try {
  const width = Number(process.env.BUS_SCREEN_WIDTH ?? 1050);
  const height = 760;
  const page = await browser.newPage({
    viewport: { width, height },
    isMobile: width < 480,
    hasTouch: width < 480,
  });
  page.setDefaultTimeout(20000);
  const manifest = await (await fetch(`${base}/api/bus/network`)).json();
  const stops = await (await fetch(new URL(manifest.stopsUrl, base))).json();
  const stop = stops.find((s) => s.stopId === stopId);
  assert.ok(stop);
  await page.goto(base);
  await page.waitForFunction(() => window.__networkReady);
  await page.evaluate(
    ([lon, lat]) =>
      window.__map.jumpTo({
        center: [lon, lat],
        zoom: 16.8,
        bearing: 0,
        pitch: 10,
      }),
    [stop.lon, stop.lat],
  );
  const activityRequest = page.waitForResponse((r) =>
    r.url().includes("/api/bus/activity?"),
  );
  await page.getByRole("button", { name: "Bus view", exact: true }).click();
  const activity = await (await activityRequest).json();
  const activeStops = new Set(activity.stops);
  const inactive = stops.find((s) => !activeStops.has(s.stopId));
  if (inactive) {
    await page.waitForFunction(
      (id) =>
        window.__map.getFeatureState({ source: "bus-curbs", id }).inactive ===
        true,
      inactive.stopId,
    );
    const inactiveRows = await (
      await fetch(
        `${base}/api/bus/departures?${new URLSearchParams({ stopId: inactive.stopId, after: String(activity.after), until: String(activity.until), networkVersion: manifest.networkVersion })}`,
      )
    ).json();
    assert.equal(inactiveRows.departures.length, 0);
    console.log("Inactive curb", inactive.name);
  }
  await page.waitForFunction(
    (id) =>
      window.__map.getLayer("bus-curbs") &&
      window.__map.queryRenderedFeatures(
        [window.innerWidth / 2, window.innerHeight / 2],
        { layers: ["bus-curbs"] },
      )[0]?.properties.stopId === id,
    stopId,
  );
  if (process.env.BUS_VERIFY_LIVE) {
    await page.waitForFunction(
      () =>
        window.__map.getSource("bus-vehicles")?.serialize().data.features
          .length > 0,
    );
    const positions = await page.evaluate(
      () => window.__map.getSource("bus-vehicles").serialize().data.features,
    );
    let chosen;
    for (const feature of positions.slice(0, 24)) {
      const trip = await (
        await fetch(
          `${base}/api/bus/trip?${new URLSearchParams({ networkVersion: manifest.networkVersion, tripKey: feature.properties.tripKey })}`,
        )
      ).json();
      if (
        trip.vehicle &&
        trip.calls.length > 2 &&
        activeStops.has(trip.calls[1].stopId)
      ) {
        chosen = feature;
        break;
      }
    }
    assert.ok(chosen, "Expected a tracked bus with an upcoming boarding stop");
    await page.evaluate(
      (c) => window.__map.jumpTo({ center: c, zoom: 19 }),
      chosen.geometry.coordinates,
    );
    await page.waitForFunction(
      (key) =>
        window.__map.queryRenderedFeatures([innerWidth / 2, innerHeight / 2], {
          layers: ["bus-vehicles"],
        })[0]?.properties.tripKey === key,
      chosen.properties.tripKey,
    );
    const tripRequest = page.waitForResponse((r) =>
      r.url().includes("/api/bus/trip?"),
    );
    await page.mouse.click(width / 2, height / 2);
    const inspected = await (await tripRequest).json();
    assert.equal(inspected.tripKey, chosen.properties.tripKey);
    const upcoming = page.getByRole("list", { name: "Upcoming stops" });
    await upcoming.waitFor();
    assert.equal(await upcoming.locator("li").count(), inspected.calls.length);
    assert.ok(
      (await page.locator("bus-panel h2").innerText()).includes(
        inspected.vehicle.vehicleId.split("_").at(-1),
      ),
    );
    await verifyRecenter(page, "Center bus", inspected.tripKey);
    if (process.env.BUS_TRIP_SCREENSHOT)
      await page.screenshot({ path: process.env.BUS_TRIP_SCREENSHOT });
    const call = inspected.calls[1];
    const target = stops.find((s) => s.stopId === call.stopId);
    const curbRequest = page.waitForResponse(
      (r) =>
        r.url().includes("/api/bus/departures?") &&
        new URL(r.url()).searchParams.get("stopId") === call.stopId,
    );
    await upcoming.locator("button").nth(1).click();
    const arrivals = await (await curbRequest).json();
    assert.equal(await page.locator("bus-panel h2").innerText(), target.name);
    await page.waitForFunction(
      (c) => {
        const p = window.__map.project(c);
        return (
          Math.abs(p.x - innerWidth / 2) < 4 &&
          Math.abs(p.y - innerHeight * 0.33) < 4
        );
      },
      [target.lon, target.lat],
    );
    const back = page.waitForResponse((r) =>
      r.url().includes("/api/bus/trip?"),
    );
    await page.locator("bus-panel .trip-link").first().click();
    const linked = await (await back).json();
    assert.equal(linked.tripKey, arrivals.departures[0].tripKey);
    console.log(
      "Bus → stop → trip",
      chosen.properties.vehicleId,
      target.name,
      linked.tripKey,
    );
    await page.getByRole("button", { name: "Close bus details" }).click();
    await page.evaluate(
      (c) => window.__map.jumpTo({ center: c }),
      [stop.lon, stop.lat],
    );
    await page.waitForFunction(
      (id) =>
        window.__map.queryRenderedFeatures(
          [window.innerWidth / 2, window.innerHeight / 2],
          { layers: ["bus-curbs"] },
        )[0]?.properties.stopId === id,
      stopId,
    );
  }
  const response = page.waitForResponse((r) =>
    r.url().includes("/api/bus/departures?"),
  );
  await page.mouse.click(width / 2, height / 2);
  const reply = await response;
  const api = await reply.json();
  if (process.env.BUS_VERIFY_LIVE)
    assert.ok(api.departures.some((d) => d.boarding.basis === "predicted"));
  assert.equal(api.networkVersion, manifest.networkVersion);
  assert.equal(new URL(reply.url()).searchParams.get("stopId"), stopId);
  const rowIndex = process.env.BUS_VERIFY_LIVE
    ? api.departures.findIndex((d) => d.boarding.basis === "predicted")
    : 0;
  const row = api.departures[rowIndex];
  assert.ok(row, "Choose a curb with service in the next hour");
  const direct = await (await fetch(reply.url())).json();
  assert.deepEqual(direct.departures[rowIndex], row);
  const entry = page.locator("bus-panel li[data-trip-key]").nth(rowIndex);
  const details = entry.locator("details");
  await details.locator("summary").click();
  assert.equal(await entry.getAttribute("data-trip-key"), row.tripKey);
  assert.equal(await entry.getAttribute("data-service-date"), row.serviceDate);
  assert.equal(
    await entry.locator(".trip-link time").getAttribute("datetime"),
    new Date(row.boarding.time).toISOString(),
  );
  assert.equal(await details.locator("li").count(), row.downstream.length);
  for (const [i, call] of row.downstream.entries()) {
    const li = details.locator("li").nth(i);
    assert.equal(await li.getAttribute("data-stop-id"), call.stopId);
    assert.equal(await li.getAttribute("data-sequence"), String(call.sequence));
    assert.equal(
      await li.locator("time").getAttribute("datetime"),
      new Date(call.time).toISOString(),
    );
  }
  await verifyRecenter(page, "Center bus stop", [stop.lon, stop.lat]);
  const panel = page.locator("bus-panel section");
  const distinct = () =>
    panel.evaluate((e) => {
      const css = getComputedStyle(e);
      return (
        css.backgroundColor === "rgb(38, 57, 80)" &&
        Number.parseFloat(css.borderWidth || "0") === 0
      );
    });
  assert.ok(await distinct());
  await panel.evaluate((e) => {
    e.style.backgroundColor = "transparent";
  });
  assert.equal(await distinct(), false);
  await panel.evaluate((e) => {
    e.style.removeProperty("background-color");
  });
  if (process.env.BUS_SCREENSHOT)
    await page.screenshot({ path: process.env.BUS_SCREENSHOT });
  console.log(
    JSON.stringify({
      stopId,
      name: stop.name,
      tripKey: row.tripKey,
      boarding: row.boarding,
      downstream: row.downstream.length,
    }),
  );
  await page.getByRole("button", { name: "Close bus details" }).click();
  if (process.env.BUS_ACTIVITY_SCREENSHOT) {
    const nearest = stops
      .filter((s) => !activeStops.has(s.stopId))
      .sort(
        (a, b) =>
          Math.hypot((a.lon - stop.lon) * 0.76, a.lat - stop.lat) -
          Math.hypot((b.lon - stop.lon) * 0.76, b.lat - stop.lat),
      )[0];
    if (nearest) {
      await page.evaluate(
        (c) =>
          window.__map.jumpTo({ center: c, zoom: 15.7, pitch: 0, bearing: 15 }),
        [nearest.lon, nearest.lat],
      );
      await page.waitForFunction(
        (id) =>
          window.__map
            .queryRenderedFeatures([innerWidth / 2, innerHeight / 2], {
              layers: ["bus-curbs"],
            })
            .some((f) => f.properties.stopId === id && f.state.inactive),
        nearest.stopId,
      );
      await page.screenshot({ path: process.env.BUS_ACTIVITY_SCREENSHOT });
    }
  }
  await page.getByRole("button", { name: "Bike view", exact: true }).click();
  assert.equal(
    await page.evaluate(() => Boolean(window.__map.getLayer("bus-curbs"))),
    false,
  );
  await page.getByRole("button", { name: "Subway view", exact: true }).click();
} finally {
  await browser.close();
}
