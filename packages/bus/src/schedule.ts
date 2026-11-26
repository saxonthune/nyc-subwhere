import type { BusNetwork } from "../../contract/src/bus";
// Pattern visits keep the source sequence even on loops. Times are seconds from GTFS service-day zero.
export type Visit = [
  stopId: string,
  sequence: number,
  pickup: number,
  dropoff: number,
];
export interface RouteTable {
  feed: string;
  routeId: string;
  routeName: string;
  patterns: Visit[][];
  offsets: number[][]; // Alternating arrival and departure seconds relative to first arrival.
  trips: [
    tripId: string,
    service: string,
    headsign: string,
    pattern: number,
    offsets: number,
    start: number,
    shapeId?: string,
  ][];
}
export interface Release extends BusNetwork {
  days: Record<string, string[]>;
  maxSeconds: number;
  activityIndex?: boolean;
}
export type LoadAsset = <T>(path: string) => Promise<T>;
export const root = (version: string) =>
  `/bus-data/${encodeURIComponent(version)}`;
const ny = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});
export function dateAt(ms: number) {
  const parts = ny.formatToParts(ms);
  const value = (part: string) => parts.find((p) => p.type === part)?.value;
  return `${value("year")}${value("month")}${value("day")}`;
}
export function utcDay(date: string) {
  return Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
}
export function serviceZero(date: string) {
  // GTFS measures elapsed seconds from local noon minus 12 hours, including DST transitions.
  const utcNoon = utcDay(date) + 12 * 3600000;
  const localHour = Number(
    ny.formatToParts(utcNoon).find((p) => p.type === "hour")?.value,
  );
  return utcNoon - localHour * 3600000;
}
export function selectRelease(
  releases: BusNetwork[],
  date: string,
  pinned: string | null,
) {
  return pinned
    ? releases.find((r) => r.networkVersion === pinned)
    : [...releases]
        .reverse()
        .find((r) => r.startDate <= date && date <= r.endDate);
}
export function tripKey(feed: string, id: string, date: string) {
  return `${date}/${feed}/${id}`;
}
export function stopBucket(id: string) {
  return (
    [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0) % 64
  );
}
export const freshMs = 120000;
export function fresh(timestamp: number | null, now: number) {
  return (
    timestamp !== null && timestamp <= now + 30000 && timestamp >= now - freshMs
  );
}
