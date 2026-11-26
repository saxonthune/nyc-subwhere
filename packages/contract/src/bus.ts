/** Shared bus API v1. Wire instants are Unix milliseconds. Service dates use YYYYMMDD in New York. */
export interface BusCurb {
  stopId: string;
  name: string;
  lon: number;
  lat: number;
  sources: [feed: string, rawStopId: string][];
}
export interface BusShape {
  type: "Feature";
  properties: { feed: string; shapeId: string; routeIds: string[] };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}
export interface BusNetwork {
  schemaVersion: 1;
  networkVersion: string;
  startDate: string;
  endDate: string;
  stopsUrl: string;
  shapesUrls: string[];
}
export interface BusEvent {
  time: number;
  basis: "scheduled" | "predicted";
  observedAt?: number;
}
export interface BusDeparture {
  tripKey: string;
  tripId: string;
  serviceDate: string;
  feed: string;
  routeId: string;
  routeName: string;
  headsign: string;
  boarding: BusEvent & { stopId: string; sequence: number };
  downstream: (BusEvent & {
    stopId: string;
    sequence: number;
    canAlight: boolean;
  })[];
}
export interface BusDepartures {
  schemaVersion: 1;
  networkVersion: string;
  asOf: number;
  departures: BusDeparture[];
  nextCursor: string | null;
}
export interface BusPrediction {
  sequence?: number;
  stopId?: string;
  arrival?: number;
  departure?: number;
  arrivalDelay?: number;
  departureDelay?: number;
  relationship?: number;
}
export interface BusUpdate {
  observedAt: number;
  canceledUntil?: number;
  delay?: number;
  calls: BusPrediction[];
}
export interface BusPosition {
  tripKey: string;
  vehicleId: string;
  observedAt: number;
  lon: number;
  lat: number;
}
export interface BusFeedStatus {
  error?: string;
  timestamp: number | null;
  lastSuccess: number | null;
  unmatched: number;
  matched: number;
  fresh: boolean;
}
export interface BusLive {
  schemaVersion: 1;
  networkVersion: string;
  asOf: number;
  tripUpdates: Record<string, BusUpdate>;
  positions: BusPosition[];
  feeds: { tripUpdates: BusFeedStatus; vehiclePositions: BusFeedStatus };
}
