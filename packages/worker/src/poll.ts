import type { RenderSnapshot, TripState } from "@nyc-subwhere/contract";
import { transit_realtime } from "./gtfs-proto.js";
import { type TripMemory, buildSnapshot, pruneMemory } from "./reshape.js";

// The eight NYCT realtime feeds (no API key required since 2023). Each covers a
// group of Routes; we fan in across all of them and merge into one snapshot.
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

// Fetch every feed, decode, and merge into one snapshot against `memory` (the
// cross-poll history, doc02.04). A trip's Vehicle Position and Trip Update
// always share a feed, so merging per-feed snapshots is safe.
//
// Returns null only when *every* feed failed: the caller keeps its last good
// snapshot rather than publish an empty frame, and memory is left un-pruned so a
// total outage does not forget every trip. Prune runs once, after all feeds, so
// a trip is only forgotten when no feed carries it.
export async function pollSnapshot(
  memory: TripMemory,
): Promise<RenderSnapshot | null> {
  const asOf = Date.now();
  const responses = await Promise.allSettled(FEEDS.map((u) => fetch(u)));

  const trips: TripState[] = [];
  const seen = new Set<string>();
  let ok = 0;
  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value.ok) continue;
    const buf = new Uint8Array(await r.value.arrayBuffer());
    const msg = transit_realtime.FeedMessage.decode(buf);
    trips.push(...buildSnapshot(msg, asOf, memory, seen).trips);
    ok++;
  }
  if (ok === 0) return null;

  pruneMemory(memory, seen);
  return { asOf, trips };
}
