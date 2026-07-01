import { transit_realtime } from "./gtfs-proto.js";
import { buildSnapshot } from "./reshape.js";

// v0 serves a single line-feed (1/2/3/4/5/6/7 + 42 St shuttle). Fan-in across
// feeds and read-through caching (doc02.04) land here later.
const FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs";

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
      const upstream = await fetch(FEED_URL);
      if (!upstream.ok) {
        return new Response(`upstream feed ${upstream.status}`, { status: 502 });
      }
      const buf = new Uint8Array(await upstream.arrayBuffer());
      const msg = transit_realtime.FeedMessage.decode(buf);
      const snapshot = buildSnapshot(msg, Date.now());
      return Response.json(snapshot, {
        headers: { "cache-control": "no-store" },
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
