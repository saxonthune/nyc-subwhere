import type {
  BusDepartures,
  BusLive,
  BusNetwork,
} from "@nyc-subwhere/contract";
import { BusError, departures } from "../../bus/src/departures";
import { inspectTrip, networkActivity } from "../../bus/src/inspection";
import {
  type Release,
  dateAt,
  root,
  selectRelease,
} from "../../bus/src/schedule";
import { assetLoader, emptyLive } from "./bus-assets";
import { historyKey, latestKey, visibleFrame } from "./bus-live";
import type { Env } from "./index";
type Cursor = {
  version: string;
  stop: string;
  after: number;
  until: number;
  now: number;
  frame: number;
  offset: number;
};
function integer(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new BusError(400, "Expected integer parameter");
  return Number(value);
}
export async function busApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const p = url.searchParams;
    if (request.method !== "GET") throw new BusError(405, "Use GET");
    const load = assetLoader(env, url.origin);
    const now = Date.now();
    const after = integer(p.get("after"), now);
    const until = integer(p.get("until"), after + 3600000);
    if (after > 8640000000000000 || until > 8640000000000000)
      throw new BusError(400, "Invalid epoch millisecond timestamp");
    const list = await load<BusNetwork[]>("/bus-data/catalog.json");
    const network = selectRelease(list, dateAt(after), p.get("networkVersion"));
    if (!network) throw new BusError(404, "No bus release covers this query");
    const version = network.networkVersion;
    if (url.pathname === "/api/bus/network") return Response.json(network);
    if (
      ![
        "/api/bus/departures",
        "/api/bus/live",
        "/api/bus/trip",
        "/api/bus/activity",
      ].includes(url.pathname)
    )
      throw new BusError(404, "Unknown bus endpoint");
    const activityCache =
      url.pathname === "/api/bus/activity"
        ? new Request(
            new URL(
              `/api/bus/activity?networkVersion=${encodeURIComponent(version)}`,
              url.origin,
            ),
          )
        : null;
    const cache = activityCache ? await caches.open("bus-map-activity") : null;
    if (activityCache && cache) {
      const hit = await cache.match(activityCache);
      if (hit) return hit;
    }
    let frame = emptyLive(version);
    if (env.BUSTIME_API_KEY) {
      const instance = env.BUS_POLLER.get(
        env.BUS_POLLER.idFromName("singleton"),
      );
      ctx.waitUntil(instance.fetch("https://poller/kick"));
    }
    const cached = await env.SNAPSHOT?.get<BusLive>(
      latestKey(version),
      "json",
    ).catch(() => null);
    if (cached?.networkVersion === version) {
      frame = cached;
      if (!env.BUSTIME_API_KEY)
        frame = {
          ...emptyLive(version),
          asOf: cached.asOf,
          tripUpdates: Object.fromEntries(
            Object.entries(cached.tripUpdates).filter(
              ([, u]) => u.canceledUntil && u.canceledUntil >= now,
            ),
          ),
        };
    }
    if (url.pathname === "/api/bus/live")
      return Response.json(
        visibleFrame(frame, now, p.get("positionsOnly") === "1"),
        { headers: { "cache-control": "no-store" } },
      );
    const release = await load<Release>(`${root(version)}/release.json`);
    if (activityCache && cache) {
      const response = Response.json(
        await networkActivity(load, release, now, frame),
        { headers: { "cache-control": "public,max-age=20" } },
      );
      ctx.waitUntil(cache.put(activityCache, response.clone()));
      return response;
    }
    if (url.pathname === "/api/bus/trip")
      return Response.json(
        await inspectTrip(load, release, p.get("tripKey") ?? "", now, frame),
        { headers: { "cache-control": "no-store" } },
      );
    const stop = p.get("stopId");
    const limit = integer(p.get("limit"), 10);
    if (
      !stop ||
      !p.has("after") ||
      until <= after ||
      until - after > 86400000 ||
      limit < 1 ||
      limit > 100
    )
      throw new BusError(
        400,
        "Provide stopId, after, a window up to 24 hours and limit 1–100",
      );
    let cursor: Cursor = {
      version,
      stop,
      after,
      until,
      now,
      frame: frame.asOf,
      offset: 0,
    };
    if (p.has("cursor")) {
      let c: Cursor;
      try {
        c = JSON.parse(atob(p.get("cursor") ?? ""));
      } catch {
        throw new BusError(400, "Invalid cursor");
      }
      if (
        !c ||
        c.version !== version ||
        c.stop !== stop ||
        c.after !== after ||
        c.until !== until ||
        !Number.isSafeInteger(c.now) ||
        !Number.isSafeInteger(c.frame) ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0
      )
        throw new BusError(400, "Cursor does not match query");
      cursor = c;
      if (!c.frame) frame = emptyLive(version);
      else if (frame.asOf !== c.frame) {
        const pinned = await env.SNAPSHOT.get<BusLive>(
          historyKey(version, c.frame),
          "json",
        );
        if (!pinned)
          throw new BusError(409, "Live page expired. Restart the query.");
        frame = pinned;
      }
    }
    const rows = await departures(
      load,
      release,
      {
        stopId: stop,
        after,
        until,
        now: cursor.now,
        offset: cursor.offset,
        count: limit + 1,
      },
      frame,
    );
    const end = cursor.offset + limit;
    const body: BusDepartures = {
      schemaVersion: 1,
      networkVersion: version,
      asOf: cursor.now,
      departures: rows.slice(0, limit),
      nextCursor:
        limit < rows.length
          ? btoa(JSON.stringify({ ...cursor, offset: end }))
          : null,
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof BusError ? e.message : "Bus data unavailable" },
      { status: e instanceof BusError ? e.status : 503 },
    );
  }
}
