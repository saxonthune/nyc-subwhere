import type {
  BikeSnapshot,
  BikeStationInfo,
  BikeStationStatus,
  BikeStationsIndex,
} from "@nyc-subwhere/contract";

// Citi Bike's GBFS feed for the Brooklyn/NYC system, no API key required.
const GBFS_BASE = "https://gbfs.lyft.com/gbfs/1.1/bkn/en/";

interface RawStationStatus {
  station_id?: string;
  num_ebikes_available?: number;
  num_bikes_available?: number;
  num_docks_available?: number;
  is_renting?: number;
  is_returning?: number;
}

interface RawStationInformation {
  station_id?: string;
  name?: string;
  lat?: number;
  lon?: number;
  capacity?: number;
}

// null on any failure — the caller keeps the last good KV frame rather than
// publish an empty one (mirrors poll.ts's convention).
export async function pollBikeSnapshot(): Promise<BikeSnapshot | null> {
  try {
    const res = await fetch(`${GBFS_BASE}station_status.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { stations?: RawStationStatus[] };
    };
    const raw = data.data?.stations ?? [];

    const stations: BikeStationStatus[] = [];
    for (const s of raw) {
      if (!s.station_id) continue;
      const ebikes = s.num_ebikes_available ?? 0;
      stations.push({
        stationId: s.station_id,
        ebikes,
        classicBikes: Math.max(0, (s.num_bikes_available ?? 0) - ebikes),
        docks: s.num_docks_available ?? 0,
        renting: s.is_renting === 1,
        returning: s.is_returning === 1,
      });
    }
    return { asOf: Date.now(), stations };
  } catch {
    return null;
  }
}

export async function pollBikeStations(): Promise<BikeStationsIndex | null> {
  try {
    const res = await fetch(`${GBFS_BASE}station_information.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { stations?: RawStationInformation[] };
    };
    const raw = data.data?.stations ?? [];

    const stations: BikeStationInfo[] = [];
    for (const s of raw) {
      if (!s.station_id) continue;
      stations.push({
        stationId: s.station_id,
        name: s.name ?? "",
        lat: s.lat ?? 0,
        lon: s.lon ?? 0,
        capacity: s.capacity ?? 0,
      });
    }
    return { asOf: Date.now(), stations };
  } catch {
    return null;
  }
}
