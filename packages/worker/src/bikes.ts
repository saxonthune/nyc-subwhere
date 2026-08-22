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
  num_bikes_disabled?: number;
  num_docks_disabled?: number;
  is_renting?: number;
  is_returning?: number;
}

interface RawStationInformation {
  station_id?: string;
  name?: string;
  lat?: number;
  lon?: number;
  capacity?: number;
  region_id?: string;
}

// The bkn feed covers New Jersey too; this app is NYC-only, so those docks are
// stripped at poll time. GBFS regions 70 (JC District) and 311 (Hoboken
// District) are New Jersey — but some Hoboken docks carry no region_id at all,
// so a geographic clause backs the region test: west of the Hudson means
// lon < -74.02 once north of Governors Island (lat > 40.695; the island's
// west shore pokes past that longitude, and Bay Ridge further south does too).
const NJ_REGIONS = new Set(["70", "311"]);
function isNewJersey(s: RawStationInformation): boolean {
  if (s.region_id != null && NJ_REGIONS.has(s.region_id)) return true;
  return (s.lon ?? 0) < -74.02 && (s.lat ?? 0) > 40.695;
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
        bikesDisabled: s.num_bikes_disabled ?? 0,
        docksDisabled: s.num_docks_disabled ?? 0,
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
      if (!s.station_id || isNewJersey(s)) continue;
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
