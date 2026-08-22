import { chromium } from "playwright";

// Deterministic screenshot of the running dev server at a camera pose (doc02.05):
// navigates the map via the window.__map debug hook, so a junction can be inspected
// by location. Paste the `shot:` line from the Advanced Stats panel straight in.
//   node shot-at.mjs <out.png> <lng> <lat> [zoom=17] [pitch=45] [bearing=0] [debugCycles=0]
//   just shot <out.png> <lng> <lat> [zoom] [pitch] [bearing]
// debugCycles calls the network layer's cycleDebug() that many times before the shot,
// so a pipeline-stage centerline view (doc02.07) can be captured (1 = first debug layer).
const [
  out,
  lng,
  lat,
  zoom = "17",
  pitch = "45",
  bearing = "0",
  debugCycles = "0",
] = process.argv.slice(2);

if (!out || !lng || !lat) {
  console.error(
    "usage: shot-at <out.png> <lng> <lat> [zoom] [pitch] [bearing]",
  );
  process.exit(1);
}

const URL = process.env.SHOT_URL ?? "http://localhost:5173/";
// SHOT_VIEW=bike switches to Bike View (doc01.04) before the shot.
const VIEW = process.env.SHOT_VIEW ?? "subway";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
page.on("pageerror", (e) => console.error("page error:", e.message));

await page.goto(URL, { waitUntil: "load" });

// Gate on the layer actually being built, NOT map.loaded(): the empty style reports
// loaded() before main.ts's async load handler adds the network layer, so gating on
// loaded() screenshots an empty map. __networkReady is set once the geometry is in.
await page.waitForFunction(() => window.__networkReady === true, {
  timeout: 30000,
});

await page.evaluate(
  ([lng, lat, zoom, pitch, bearing]) => {
    window.__map.jumpTo({ center: [lng, lat], zoom, pitch, bearing });
  },
  [Number(lng), Number(lat), Number(zoom), Number(pitch), Number(bearing)],
);

if (VIEW === "bike")
  await page.evaluate(() => window.__networkLayer.setViewMode("bike"));

for (let i = 0; i < Number(debugCycles); i++)
  await page.evaluate(() => window.__networkLayer.cycleDebug());

// The custom layer calls triggerRepaint() every frame, so the map never fires
// 'idle' — wait a fixed settle for the new camera matrix + a few redraws instead.
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
await browser.close();
console.log("shot", out);
