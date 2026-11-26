import type { BusLive } from "@nyc-subwhere/contract";
import { BusError } from "../../bus/src/departures";
import type { LoadAsset } from "../../bus/src/schedule";
import type { Env } from "./index";

// The deployment archive retains pinned quarters after a new Worker replaces its assets.
export async function busAsset(env: Env, url: URL): Promise<Response> {
  const path = decodeURIComponent(url.pathname);
  if (env.BUS_SCHEDULE_ARCHIVE === "enabled") {
    const stream = await env.SNAPSHOT.get(`schedule:${path}`, "stream");
    if (stream)
      return new Response(stream, {
        headers: {
          "content-type": "application/json",
          "cache-control": path.endsWith("/catalog.json")
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        },
      });
  }
  return env.ASSETS.fetch(url);
}
export function assetLoader(env: Env, origin: string): LoadAsset {
  return async <T>(path: string) => {
    const r = await busAsset(env, new URL(path, origin));
    if (!r.ok) throw new BusError(503, "Bus schedule asset unavailable");
    return r.json<T>();
  };
}
export function emptyLive(version: string): BusLive {
  const status = {
    timestamp: null,
    lastSuccess: null,
    matched: 0,
    unmatched: 0,
    fresh: false,
  };
  return {
    schemaVersion: 1,
    networkVersion: version,
    asOf: 0,
    tripUpdates: {},
    positions: [],
    feeds: { tripUpdates: { ...status }, vehiclePositions: { ...status } },
  };
}
