import type { TripState } from "@nyc-subwhere/contract";
import { transit_realtime } from "./gtfs-proto.js";
import { buildSnapshot } from "./reshape.js";

// The eight NYCT realtime feeds (no API key required since 2023). Each covers a
// group of Routes; we fan in across all of them and merge into one snapshot.
// Read-through caching (doc02.04) lands here later.
const FEED_BASE =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";
const FEEDS = [
  "gtfs", // 1 2 3 4 5 6 7 + 42 St shuttle
  "gtfs-ace", // A C E + Rockaway Park shuttle (H)
  "gtfs-bdfm", // B D F M + Franklin Av shuttle (FS)
  "gtfs-g", // G
  "gtfs-jz", // J Z
  "gtfs-nqrw", // N Q R W
  "gtfs-l", // L
  "gtfs-si", // Staten Island Railway
].map((f) => `${FEED_BASE}${f}`);

export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/trips") {
      const asOf = Date.now();
      const responses = await Promise.allSettled(FEEDS.map((u) => fetch(u)));

      const trips: TripState[] = [];
      let ok = 0;
      for (const r of responses) {
        if (r.status !== "fulfilled" || !r.value.ok) continue;
        const buf = new Uint8Array(await r.value.arrayBuffer());
        const msg = transit_realtime.FeedMessage.decode(buf);
        trips.push(...buildSnapshot(msg, asOf).trips);
        ok++;
      }
      // A trip's Vehicle Position and Trip Update always share a feed, so merging
      // per-feed snapshots is safe. Only 502 if every feed failed.
      if (ok === 0) {
        return new Response("all upstream feeds failed", { status: 502 });
      }
      return Response.json(
        { asOf, trips },
        { headers: { "cache-control": "no-store" } },
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
