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
try {
  const page = await browser.newPage({
    viewport: { width: 1050, height: 760 },
  });
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
  await page.getByRole("button", { name: "Bus view", exact: true }).click();
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
    const observed = await page.evaluate(() => {
      const map = window.__map;
      const features = map.getSource("bus-vehicles").serialize().data.features;
      const p = features.find(
        (f) => Date.now() - f.properties.observedAt < 120000,
      );
      map.jumpTo({ center: p.geometry.coordinates });
      return p.properties;
    });
    await page.waitForFunction(
      (id) =>
        window.__map
          .queryRenderedFeatures(
            [window.innerWidth / 2, window.innerHeight / 2],
            { layers: ["bus-vehicles"] },
          )
          .some((f) => f.properties.vehicleId === id),
      observed.vehicleId,
    );
    console.log("Rendered live bus", observed.vehicleId, observed.tripKey);
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
  await page.mouse.click(525, 380);
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
  const details = page.locator("bus-panel details").nth(rowIndex);
  await details.locator("summary").click();
  assert.equal(await details.getAttribute("data-trip-key"), row.tripKey);
  assert.equal(
    await details.getAttribute("data-service-date"),
    row.serviceDate,
  );
  assert.equal(
    await details.locator("summary time").getAttribute("datetime"),
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
  await page.getByRole("button", { name: "Bike view", exact: true }).click();
  assert.equal(
    await page.evaluate(() => Boolean(window.__map.getLayer("bus-curbs"))),
    false,
  );
  await page.getByRole("button", { name: "Subway view", exact: true }).click();
} finally {
  await browser.close();
}
