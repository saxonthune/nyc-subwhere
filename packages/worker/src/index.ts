import type { RenderSnapshot } from "@nyc-subwhere/contract";
import { pollSnapshot } from "./poll.js";
import type { TripMem, TripMemory } from "./reshape.js";

// The MTA publishes each feed on a ~30s cadence, so we refresh on the same beat.
const POLL_INTERVAL_MS = 30_000;
const SNAPSHOT_KEY = "trips:snapshot";
// One poller owns the loop; a fixed name keeps every request routed to the same
// Durable Object instance.
const POLLER_NAME = "singleton";

export interface Env {
  ASSETS: Fetcher;
  SNAPSHOT: KVNamespace;
  FEED_POLLER: DurableObjectNamespace;
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
      const poller = env.FEED_POLLER.get(env.FEED_POLLER.idFromName(POLLER_NAME));
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
