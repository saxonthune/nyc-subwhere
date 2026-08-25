import type {
  BikeSnapshot,
  BikeStationsIndex,
  RenderSnapshot,
} from "@nyc-subwhere/contract";
import { pollBikeSnapshot, pollBikeStations } from "./bikes.js";
import { pollSnapshot } from "./poll.js";
import type { TripMem, TripMemory } from "./reshape.js";

// The MTA publishes each feed on a ~30s cadence, so we refresh on the same beat.
const POLL_INTERVAL_MS = 30_000;
const SNAPSHOT_KEY = "trips:snapshot";
// One poller owns the loop; a fixed name keeps every request routed to the same
// Durable Object instance.
const POLLER_NAME = "singleton";

const BIKE_SNAPSHOT_KEY = "bikes:snapshot";
const BIKE_STATIONS_KEY = "bikes:stations";
// Station identity (doc02.09) changes seasonally, unlike the 30s live counts,
// so a daily refresh is plenty.
const STATIONS_REFRESH_MS = 86_400_000;

export interface Env {
  ASSETS: Fetcher;
  SNAPSHOT: KVNamespace;
  FEED_POLLER: DurableObjectNamespace;
  BIKE_POLLER: DurableObjectNamespace;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/trips") {
      // The read path never decodes feeds — that work lives in the poller, which
      // writes the finished frame to KV every 30s. A hit here wakes the poller if
      // it has gone idle; fire-and-forget so the response never waits on it.
      const poller = env.FEED_POLLER.get(
        env.FEED_POLLER.idFromName(POLLER_NAME),
      );
      ctx.waitUntil(poller.fetch("https://poller/kick"));

      const cached = await env.SNAPSHOT.get(SNAPSHOT_KEY);
      if (cached == null) {
        // The loop just started and has not published yet: an empty frame the
        // client renders as "no trains" and clears on its next 30s poll.
        const warming: RenderSnapshot = { asOf: Date.now(), trips: [] };
        return Response.json(warming, {
          headers: { "cache-control": "no-store" },
        });
      }
      return new Response(cached, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/bikes") {
      const poller = env.BIKE_POLLER.get(
        env.BIKE_POLLER.idFromName(POLLER_NAME),
      );
      ctx.waitUntil(poller.fetch("https://poller/kick"));

      const cached = await env.SNAPSHOT.get(BIKE_SNAPSHOT_KEY);
      if (cached == null) {
        const warming: BikeSnapshot = { asOf: Date.now(), stations: [] };
        return Response.json(warming, {
          headers: { "cache-control": "no-store" },
        });
      }
      return new Response(cached, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/bike-stations") {
      const poller = env.BIKE_POLLER.get(
        env.BIKE_POLLER.idFromName(POLLER_NAME),
      );
      ctx.waitUntil(poller.fetch("https://poller/kick"));

      const cached = await env.SNAPSHOT.get(BIKE_STATIONS_KEY);
      if (cached == null) {
        // Daily-refresh frame: served no-store while empty so a client that
        // hits the warming case retries soon rather than caching a mile-wide gap.
        const warming: BikeStationsIndex = { asOf: Date.now(), stations: [] };
        return Response.json(warming, {
          headers: { "cache-control": "no-store" },
        });
      }
      return new Response(cached, {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=300",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// The single producer (doc02.04): a self-rescheduling 30s alarm loop that fetches
// the feeds, reshapes against a cross-poll memory, and publishes the frame to KV.
// Being one instance makes that memory a single coherent history — earlier
// per-request decoding gave each edge isolate its own, so cross-poll diffs
// disagreed. The memory is persisted to DO storage so it survives eviction
// between alarms.
export class FeedPoller implements DurableObject {
  private memory: TripMemory | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  // The kick: ensure the alarm loop is running. Idempotent — if an alarm is
  // already pending we leave it, so concurrent kicks cost nothing.
  async fetch(_request: Request): Promise<Response> {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now());
    }
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const memory = await this.loadMemory();
    try {
      const snap = await pollSnapshot(memory);
      // null = every feed failed this cycle; keep the last good frame in KV.
      if (snap != null) {
        await this.env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(snap));
      }
      await this.state.storage.put("memory", [...memory]);
    } finally {
      // Reschedule unconditionally so a thrown poll cannot kill the loop.
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  private async loadMemory(): Promise<TripMemory> {
    if (this.memory == null) {
      const stored =
        await this.state.storage.get<[string, TripMem][]>("memory");
      this.memory = new Map(stored ?? []);
    }
    return this.memory;
  }
}

// Second poller for the Citi Bike GBFS feeds (doc02.09). Deliberately
// duplicates FeedPoller's kick/alarm boilerplate rather than sharing a base
// class — the two pollers share a pattern, not a future.
export class BikePoller implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now());
    }
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    try {
      const snap = await pollBikeSnapshot();
      if (snap != null) {
        await this.env.SNAPSHOT.put(BIKE_SNAPSHOT_KEY, JSON.stringify(snap));
      }

      const stationsAt =
        (await this.state.storage.get<number>("stationsAt")) ?? 0;
      if (Date.now() - stationsAt >= STATIONS_REFRESH_MS) {
        const stations = await pollBikeStations();
        if (stations != null) {
          await this.env.SNAPSHOT.put(
            BIKE_STATIONS_KEY,
            JSON.stringify(stations),
          );
          await this.state.storage.put("stationsAt", Date.now());
        }
      }
    } finally {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }
}
