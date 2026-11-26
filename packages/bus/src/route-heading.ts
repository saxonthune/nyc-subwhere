import type { BusPosition, BusShape } from "../../contract/src/bus";
import { type LoadAsset, root } from "./schedule";

type StopAnchor = [sequence: number, rawStopId: string, vertex: number];
interface TripPath {
  shapeId: string;
  reverse: boolean;
  stops: StopAnchor[];
}
interface ShapeAsset {
  features: BusShape[];
  tripPaths: TripPath[];
}
interface FeedPaths {
  geometry: Map<string, Float64Array>;
  paths: TripPath[];
}
export interface VehicleOnPath {
  position: BusPosition;
  pathIndex: number;
  stopId?: string;
  sequence?: number;
}

// Select the closest directed segment, in metres at the bus's latitude.
// Near-coincident legs travelling in opposite directions require stop progress.
function closestSegment(
  coords: Float64Array,
  first: number,
  end: number,
  bus: BusPosition,
  reverse: boolean,
) {
  const eastScale = 111320 * Math.cos((bus.lat * Math.PI) / 180);
  let nearest = Number.POSITIVE_INFINITY;
  const nearby: { distance: number; angle: number }[] = [];
  for (let i = first; i < end; i++) {
    const k = 2 * i;
    const x = (coords[k] - bus.lon) * eastScale;
    const y = (coords[k + 1] - bus.lat) * 111320;
    const dx = (coords[k + 2] - coords[k]) * eastScale;
    const dy = (coords[k + 3] - coords[k + 1]) * 111320;
    const length2 = dx * dx + dy * dy;
    if (length2 < 0.25) continue;
    const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / length2));
    const distance = Math.hypot(x + t * dx, y + t * dy);
    if (distance > 40 || distance > nearest + 5) continue;
    nearest = Math.min(distance, nearest);
    nearby.push({ distance, angle: (Math.atan2(dx, dy) * 180) / Math.PI });
  }
  if (!nearby.length) return undefined;
  const best = nearby.reduce((a, b) => (a.distance <= b.distance ? a : b));
  const ambiguous = nearby.some((c) => {
    const turn = Math.abs(((c.angle - best.angle + 540) % 360) - 180);
    return c.distance <= nearest + 5 && turn > 100;
  });
  const bearing = ambiguous
    ? undefined
    : (best.angle + (reverse ? 180 : 0) + 360) % 360;
  return { distance: best.distance, bearing };
}

export function routeHeading(
  coords: Float64Array,
  path: TripPath,
  vehicle: VehicleOnPath,
) {
  const last = coords.length / 2 - 1;
  let visit = -1;
  if (vehicle.sequence != null) {
    visit = path.stops.findIndex(
      ([seq, id]) =>
        seq === vehicle.sequence && (!vehicle.stopId || id === vehicle.stopId),
    );
  }
  if (visit < 0 && vehicle.stopId) {
    const i = path.stops.findIndex(([, id]) => id === vehicle.stopId);
    if (
      i >= 0 &&
      !path.stops.slice(i + 1).some(([, id]) => id === vehicle.stopId)
    )
      visit = i;
  }
  let approach: ReturnType<typeof closestSegment>;
  if (visit >= 0) {
    const originVertex = path.reverse ? last : 0;
    const from = visit > 0 ? path.stops[visit - 1][2] : originVertex;
    let to = path.stops[visit][2];
    // A bus waiting at the first curb faces into its first scheduled leg.
    if (visit === 0 && from === to && path.stops.length > 1)
      to = path.stops[1][2];
    approach = closestSegment(
      coords,
      Math.min(from, to),
      Math.max(from, to),
      vehicle.position,
      path.reverse,
    );
    if (approach && approach.distance <= 8 && approach.bearing !== undefined)
      return approach.bearing;
  }
  const anywhere = closestSegment(
    coords,
    0,
    last,
    vehicle.position,
    path.reverse,
  );
  // Allow for GPS noise on parallel lanes, but a lagging stop reference must
  // not pin a bus to an earlier street once its location clearly contradicts it.
  if (
    approach?.bearing !== undefined &&
    anywhere &&
    approach.distance <= anywhere.distance + 8
  )
    return approach.bearing;
  return anywhere?.bearing;
}

// Cache compact geometry in the poller for one immutable release. The browser
// receives the resolved angle and can rotate a shared sprite without searching routes.
export class BusPaths {
  private feeds = new Map<string, FeedPaths>();
  constructor(
    readonly version: string,
    private load: LoadAsset,
  ) {}
  async align(feed: string, vehicles: VehicleOnPath[]) {
    let data = this.feeds.get(feed);
    if (!data) {
      const asset = await this.load<ShapeAsset>(
        `${root(this.version)}/shapes-${feed}.json`,
      );
      const geometry = new Map<string, Float64Array>();
      for (const feature of asset.features)
        geometry.set(
          feature.properties.shapeId,
          Float64Array.from(feature.geometry.coordinates.flat()),
        );
      data = { geometry, paths: asset.tripPaths };
      this.feeds.set(feed, data);
    }
    for (const vehicle of vehicles) {
      const path = data.paths[vehicle.pathIndex];
      const coords = path && data.geometry.get(path.shapeId);
      if (coords)
        vehicle.position.routeBearing = routeHeading(coords, path, vehicle);
    }
  }
}
