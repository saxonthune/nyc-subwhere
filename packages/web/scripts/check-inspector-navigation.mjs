// Exercise the production pick handler and map navigation with a repeatable full timetable.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:8797";
const asset = async (name) =>
  JSON.parse(
    await readFile(new URL(`../src/assets/${name}`, import.meta.url), "utf8"),
  );
const tracks = (await asset("track-index.json")).tracks;
const stations = (await asset("stations.geojson")).features;
const stationIndex = stations.findIndex((s) => s.properties.stopId === "Q01");
const start = Date.now();
const trips = [];
for (const direction of ["N", "S"]) {
  const track = tracks.find(
    (t) => t.routeId === "Q" && t.direction === direction,
  );
  const index = track.stops.findIndex((s) => s.stopId === `Q01${direction}`);
  for (let i = 0; i < 12; i++) {
    const upcoming = track.stops.slice(index).map((s, j) => ({
      stopId: s.stopId,
      arrival: start + (i + j + 1) * 60000,
      departure: null,
    }));
    trips.push({
      tripId: `${String(71400 + 100 * Math.floor(i / 2)).padStart(6, "0")}_Q..${direction}${i}`,
      routeId: "Q",
      direction,
      lastKnownStop: {
        stopId: track.stops[index - 1].stopId,
        at: start - 30000,
      },
      upcoming: i === 10 ? upcoming.slice(0, 1) : upcoming,
      predictedStops: i === 10 ? upcoming : undefined,
      status: i === 10 ? "stalled" : "progressing",
    });
  }
}
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
  for (const width of [1050, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 780 },
      isMobile: width < 480,
      hasTouch: width < 480,
    });
    page.setDefaultTimeout(18000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/trips", (r) =>
      r.fulfill({ json: { asOf: start, trips } }),
    );
    await page.goto(base);
    await page.waitForFunction(
      () =>
        typeof document.querySelector("menu-panel")?.onViewSelect ===
        "function",
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const bus = button("Bus view");
    const bike = button("Bike view");
    const b = await bus.boundingBox();
    const k = await bike.boundingBox();
    assert.ok(b.x >= k.x + k.width);
    assert.equal(await bus.locator("svg").isVisible(), width <= 480);
    if (width <= 480) {
      const controls = page
        .getByRole("group", { name: "Map view" })
        .getByRole("button");
      for (const control of await controls.all()) {
        const target = await control.boundingBox();
        const icon = await control.locator("svg").boundingBox();
        assert.ok(target && icon);
        assert.ok(
          Math.abs(icon.x + icon.width / 2 - target.x - target.width / 2) < 0.5,
        );
        assert.ok(
          Math.abs(icon.y + icon.height / 2 - target.y - target.height / 2) <
            0.5,
        );
      }
    }
    await bus.click();
    await page.waitForFunction(() => window.__map.getLayer("bus-curbs"));
    assert.equal(await bus.getAttribute("aria-pressed"), "true");
    await bike.click();
    assert.equal(
      await page.evaluate(() => !!window.__map.getLayer("bus-curbs")),
      false,
    );
    await button("Subway view").click();
    const point = await page.evaluate(
      async ({ coords, index }) => {
        const map = window.__map;
        map.jumpTo({ center: coords, zoom: 18, bearing: 0, pitch: 0 });
        await new Promise((r) => map.once("render", r));
        const p = map.project(coords);
        for (let dy = -12; dy <= 12; dy += 2)
          for (let dx = -12; dx <= 12; dx += 2) {
            const x = p.x + dx;
            const y = p.y + dy;
            const pick = window.__networkLayer.pick({ x, y });
            if (pick?.kind === "station" && pick.stationIndex === index)
              return { x, y };
          }
        throw Error("Canal St curbside station pick missing");
      },
      {
        coords: stations[stationIndex].geometry.coordinates,
        index: stationIndex,
      },
    );
    await page.mouse.click(point.x, point.y);
    const panel = page.locator("inspector-panel");
    const board = panel.locator(".board").first();
    const rows = board.locator(".arrival");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 12);
    assert.equal(
      new Set(await rows.locator(".train-id").allTextContents()).size,
      12,
    );
    const scrollable = (el) =>
      el.scrollHeight > el.clientHeight &&
      getComputedStyle(el).overflowY === "auto";
    assert.ok(await board.locator("ul").evaluate(scrollable));
    const chosen = rows.nth(10);
    await chosen.scrollIntoViewIfNeeded();
    assert.ok(await board.locator("ul").evaluate((el) => el.scrollTop > 0));
    const label = await chosen.locator(".train-id").innerText();
    const id = await chosen.getAttribute("title");
    const verifyFill = (el) =>
      getComputedStyle(el).backgroundColor === "rgb(37, 53, 69)" &&
      getComputedStyle(el).borderTopWidth === "0px";
    assert.ok(await panel.locator(".panel").evaluate(verifyFill));
    await panel.locator(".panel").evaluate((e) => {
      e.style.backgroundColor = "transparent";
    });
    assert.equal(await panel.locator(".panel").evaluate(verifyFill), false);
    await panel.locator(".panel").evaluate((e) => {
      e.style.removeProperty("background-color");
    });
    const stationBox = await panel.locator(".panel").boundingBox();
    assert.ok(stationBox.height < 355 && stationBox.width <= 340);
    if (process.env.INSPECTOR_SHOTS)
      await page.screenshot({ path: `/tmp/subwhere-station-${width}.png` });
    // The camera follows the position at selection time. The train keeps moving.
    await panel.evaluate((host) =>
      host.addEventListener(
        "trip-select",
        (e) => {
          window.__pickedPose = window.__networkLayer.currentPoses.find(
            (p) => p.tripId === e.detail.tripId,
          )?.lngLat;
        },
        { once: true, capture: true },
      ),
    );
    await chosen.focus();
    await chosen.press("Enter");
    assert.equal(await panel.locator(".train .train-id").innerText(), label);
    assert.equal(
      await panel.locator(".train [title]").getAttribute("title"),
      id,
    );
    await page.waitForFunction(
      () => {
        if (!window.__pickedPose) return false;
        const p = window.__map.project(window.__pickedPose);
        return (
          Math.abs(p.x - innerWidth / 2) < 8 &&
          Math.abs(p.y - innerHeight * 0.33) < 8
        );
      },
      undefined,
      { timeout: 12000 },
    );
    const calls = trips.find((t) => t.tripId === id).predictedStops;
    assert.equal(await panel.locator(".train li").count(), calls.length + 1);
    const trainBox = await panel.locator(".panel").boundingBox();
    assert.ok(trainBox.height < 265 && trainBox.width <= 320);
    assert.ok(await panel.locator(".train ul").evaluate(scrollable));
    if (process.env.INSPECTOR_SHOTS)
      await page.screenshot({ path: `/tmp/subwhere-train-${width}.png` });
    const dest = stations.find((s) =>
      s.properties.platforms.includes(calls.at(-1).stopId),
    );
    const last = panel.locator(".train li button").last();
    await last.scrollIntoViewIfNeeded();
    assert.ok(
      await panel.locator(".train ul").evaluate((el) => el.scrollTop > 0),
    );
    assert.equal(await last.locator(".name").innerText(), dest.properties.name);
    await last.click();
    assert.equal(
      await panel.locator(".title").innerText(),
      dest.properties.name,
    );
    await page.waitForFunction((coords) => {
      const p = window.__map.project(coords);
      return (
        Math.abs(p.x - innerWidth / 2) < 4 &&
        Math.abs(p.y - innerHeight * 0.33) < 4
      );
    }, dest.geometry.coordinates);
    await bus.click();
    assert.equal(await panel.locator(".panel").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      width,
      label,
      `${calls.length} upcoming stops`,
      `${stationBox.height}px station`,
      `${trainBox.height}px train`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
