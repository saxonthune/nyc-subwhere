import type { BusFeedStatus, BusLive, BusUpdate } from "@nyc-subwhere/contract";
import { Reader } from "protobufjs/minimal.js";
import { BusPaths, type VehicleOnPath } from "../../bus/src/route-heading";
import {
  type LoadAsset,
  type Release,
  dateAt,
  fresh,
  root,
  selectRelease,
  serviceZero,
  tripKey,
} from "../../bus/src/schedule";
import { assetLoader, emptyLive } from "./bus-assets";
import { transit_realtime as rt } from "./gtfs-proto.js";
import type { Env } from "./index";

type Kind = "tripUpdates" | "vehiclePositions";
const kinds: Kind[] = ["tripUpdates", "vehiclePositions"];
const endpoints = "https://gtfsrt.prod.obanyc.com/";
type TripMatch = {
  feed: string;
  route: string;
  end: number;
  pathIndex?: number;
  key: string;
};
type Matches = Map<string, TripMatch[]>;
async function matchesForDate(
  load: LoadAsset,
  release: Release,
  date: string,
): Promise<Matches> {
  const matches: Matches = new Map();
  for (const service of release.days[date] ?? []) {
    const feed = service.split(":")[0];
    const trips = await load<Record<string, [string, number, number?]>>(
      `${root(release.networkVersion)}/services/${encodeURIComponent(service)}.json`,
    );
    for (const [id, [route, seconds, pathIndex]] of Object.entries(trips)) {
      const match = {
        feed,
        route,
        end: seconds,
        pathIndex,
        key: tripKey(feed, id, date),
      };
      const list = matches.get(id);
      if (list) list.push(match);
      else matches.set(id, [match]);
    }
  }
  return matches;
}
function present(object: object, field: string) {
  return Object.hasOwn(object, field);
}
function millis(seconds: unknown) {
  return Number(seconds) * 1000;
}
function keepCancellations(prior: Record<string, BusUpdate>, now: number) {
  return Object.fromEntries(
    Object.entries(prior).filter(
      ([, v]) => v.canceledUntil && v.canceledUntil >= now,
    ),
  );
}
// Decode one entity at a time. A citywide message expands substantially in memory.
function* entities(bytes: Uint8Array) {
  const reader = Reader.create(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag === 18) yield rt.FeedEntity.decode(reader.bytes());
    else reader.skipType(tag & 7);
  }
}
function header(bytes: Uint8Array) {
  const r = Reader.create(bytes);
  while (r.pos < r.len) {
    const tag = r.uint32();
    if (tag === 10) return rt.FeedHeader.decode(r.bytes());
    r.skipType(tag & 7);
  }
  throw new Error("Missing feed header");
}
type FetchFeed = (kind: Kind) => Promise<Uint8Array>;
export async function pollBuses(
  release: Release,
  load: LoadAsset,
  fetchFeed: FetchFeed,
  now: number,
  previous?: BusLive,
  paths = new BusPaths(release.networkVersion, load),
): Promise<BusLive> {
  const old =
    previous?.networkVersion === release.networkVersion ? previous : undefined;
  const frame: BusLive = {
    ...(old ?? emptyLive(release.networkVersion)),
    asOf: now,
    feeds: { ...(old ?? emptyLive(release.networkVersion)).feeds },
  };
  const days = new Map<string, Matches>();
  for (const kind of kinds) {
    let stage = "fetch";
    try {
      const bytes = await fetchFeed(kind);
      stage = "decode";
      const meta = header(bytes);
      const timestamp = millis(meta.timestamp);
      if (
        !timestamp ||
        meta.incrementality === 1 ||
        timestamp < (frame.feeds[kind].timestamp ?? 0)
      )
        continue;
      const status: BusFeedStatus = {
        timestamp,
        lastSuccess: now,
        matched: 0,
        unmatched: 0,
        fresh: fresh(timestamp, now),
      };
      const updates = keepCancellations(frame.tripUpdates, now);
      const positions: BusLive["positions"] = [];
      const byFeed = new Map<string, VehicleOnPath[]>();
      for (const entity of entities(bytes)) {
        const data =
          kind === "tripUpdates" ? entity.tripUpdate : entity.vehicle;
        if (!data?.trip?.tripId || !data.trip.startDate) {
          status.unmatched++;
          continue;
        }
        const d = data.trip;
        const date = data.trip.startDate;
        if (!days.has(date)) {
          stage = "match-index";
          days.set(date, await matchesForDate(load, release, date));
          stage = "decode";
        }
        const choices = (days.get(date)?.get(d.tripId as string) ?? []).filter(
          (t) => !d.routeId || t.route === d.routeId,
        );
        if (
          choices.length !== 1 ||
          (d.scheduleRelationship && d.scheduleRelationship !== 3)
        ) {
          status.unmatched++;
          continue;
        }
        const m = choices[0];
        const observedAt = present(data, "timestamp")
          ? millis(data.timestamp)
          : timestamp;
        status.matched++;
        if (kind === "vehiclePositions") {
          const v = entity.vehicle;
          if (v?.position && v.vehicle?.id) {
            // Protobuf supplies a default zero even when the feed omits bearing.
            const bearing = v.position.bearing;
            const hasBearing =
              present(v.position, "bearing") &&
              typeof bearing === "number" &&
              Number.isFinite(bearing) &&
              bearing >= 0 &&
              bearing <= 360;
            const position: BusLive["positions"][number] = {
              bearing: hasBearing ? bearing % 360 : undefined,
              tripKey: m.key,
              vehicleId: v.vehicle.id,
              lat: v.position.latitude,
              lon: v.position.longitude,
              observedAt,
              nextStopId: v.stopId || undefined,
              nextSequence: present(v, "currentStopSequence")
                ? (v.currentStopSequence ?? undefined)
                : undefined,
            };
            positions.push(position);
            if (m.pathIndex != null) {
              const stopId = v.stopId || undefined;
              const update = frame.tripUpdates[m.key];
              const next = update?.calls[0];
              const sequence = present(v, "currentStopSequence")
                ? v.currentStopSequence
                : next &&
                    next.stopId === stopId &&
                    Math.abs(update.observedAt - observedAt) <= 60000
                  ? next.sequence
                  : undefined;
              position.nextSequence = sequence ?? undefined;
              const batch = byFeed.get(m.feed) ?? [];
              batch.push({
                position,
                pathIndex: m.pathIndex,
                stopId,
                sequence: sequence ?? undefined,
              });
              byFeed.set(m.feed, batch);
            }
          }
        } else {
          const u = entity.tripUpdate;
          if (!u) continue;
          const update: BusUpdate = { observedAt, calls: [] };
          if (d.scheduleRelationship === 3) {
            update.canceledUntil = serviceZero(date) + m.end * 1000;
          } else {
            if (present(u, "delay")) update.delay = u.delay ?? undefined;
            for (const call of u.stopTimeUpdate ?? []) {
              const p: BusUpdate["calls"][number] = {};
              if (present(call, "stopSequence"))
                p.sequence = call.stopSequence ?? undefined;
              if (call.stopId) p.stopId = call.stopId;
              if (call.scheduleRelationship)
                p.relationship = call.scheduleRelationship;
              if (call.arrival && present(call.arrival, "time"))
                p.arrival = millis(call.arrival.time);
              if (call.departure && present(call.departure, "time"))
                p.departure = millis(call.departure.time);
              if (call.arrival && present(call.arrival, "delay"))
                p.arrivalDelay = call.arrival.delay ?? undefined;
              if (call.departure && present(call.departure, "delay"))
                p.departureDelay = call.departure.delay ?? undefined;
              update.calls.push(p);
            }
          }
          if (
            (updates[m.key]?.observedAt ?? 0) <= observedAt &&
            (!updates[m.key]?.canceledUntil || update.canceledUntil)
          )
            updates[m.key] = update;
        }
      }
      if (kind === "tripUpdates") frame.tripUpdates = updates;
      else {
        for (const [feed, batch] of byFeed) {
          try {
            await paths.align(feed, batch);
          } catch {
            status.error = "Route geometry unavailable";
          }
        }
        frame.positions = positions;
      }
      frame.feeds[kind] = status;
    } catch (e) {
      const detail =
        e instanceof Error &&
        /^(HTTP [0-9]{3}|AbortError|TimeoutError|TypeError)$/.test(e.message)
          ? e.message
          : e instanceof Error
            ? e.name
            : "Error";
      frame.feeds[kind] = { ...frame.feeds[kind], error: `${stage} ${detail}` };
    }
  }
  return frame;
}
export function visibleFrame(
  frame: BusLive,
  now: number,
  positionsOnly = false,
): BusLive {
  const feeds = { ...frame.feeds };
  for (const kind of kinds)
    feeds[kind] = { ...feeds[kind], fresh: fresh(feeds[kind].timestamp, now) };
  const updates: BusLive["tripUpdates"] = {};
  if (!positionsOnly)
    for (const [key, u] of Object.entries(frame.tripUpdates)) {
      if (
        u.canceledUntil
          ? u.canceledUntil >= now
          : feeds.tripUpdates.fresh && fresh(u.observedAt, now)
      )
        updates[key] = u;
    }
  return {
    ...frame,
    feeds,
    tripUpdates: updates,
    positions: feeds.vehiclePositions.fresh
      ? frame.positions.filter((p) => fresh(p.observedAt, now))
      : [],
  };
}
export const latestKey = (version: string) => `bus:${version}:latest`;
export const historyKey = (version: string, stamp: number) =>
  `bus:${version}:${stamp}`;

export class BusPoller implements DurableObject {
  private paths?: BusPaths;
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  async fetch() {
    if (
      this.env.BUSTIME_API_KEY &&
      (await this.state.storage.getAlarm()) === null
    )
      await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 204 });
  }
  async alarm() {
    const key = this.env.BUSTIME_API_KEY?.trim();
    if (!key) return;
    try {
      const load = assetLoader(this.env, "https://bus.internal");
      const releases = await load<Release[]>("/bus-data/catalog.json");
      const now = Date.now();
      const day = dateAt(now);
      const net = selectRelease(releases, day, null);
      if (!net) return;
      const release = await load<Release>(
        `${root(net.networkVersion)}/release.json`,
      );
      const latest = latestKey(net.networkVersion);
      const old = await this.env.SNAPSHOT.get<BusLive>(latest, "json");
      if (this.paths?.version !== net.networkVersion)
        this.paths = new BusPaths(net.networkVersion, load);
      const frame = await pollBuses(
        release,
        load,
        async (kind) => {
          const url = new URL(kind, endpoints);
          url.searchParams.set("key", key);
          const res = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(12000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        },
        now,
        old ?? undefined,
        this.paths,
      );
      // KV reads can lag a poll. Keep cancellation expiry in the singleton's
      // strongly consistent storage so a later full dataset cannot revive a trip.
      const prefix = `cancel:${net.networkVersion}:`;
      const saved = await this.state.storage.list<BusUpdate>({
        prefix: "cancel:",
      });
      for (const [storageKey, update] of saved) {
        if ((update.canceledUntil ?? 0) < now) {
          await this.state.storage.delete(storageKey);
        } else if (storageKey.startsWith(prefix)) {
          const id = storageKey.slice(prefix.length);
          if (
            (frame.tripUpdates[id]?.canceledUntil ?? 0) <
            (update.canceledUntil ?? 0)
          )
            frame.tripUpdates[id] = update;
        }
      }
      for (const [id, update] of Object.entries(frame.tripUpdates)) {
        if (
          update.canceledUntil &&
          update.canceledUntil >= now &&
          saved.get(prefix + id)?.canceledUntil !== update.canceledUntil
        )
          await this.state.storage.put(prefix + id, update);
      }
      const json = JSON.stringify(frame);
      await this.env.SNAPSHOT.put(historyKey(net.networkVersion, now), json, {
        expirationTtl: 900,
      });
      await this.env.SNAPSHOT.put(latest, json);
    } finally {
      await this.state.storage.setAlarm(Date.now() + 30000);
    }
  }
}
