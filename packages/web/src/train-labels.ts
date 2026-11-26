import type { TripState } from "@nyc-subwhere/contract";

// A short rider-facing reference for one live trip. NYCT's leading six digits
// give its scheduled origin time in hundredths of a minute since service midnight.
export class TrainLabels {
  private labels = new Map<string, string>();
  private counts = new Map<string, number>();

  register(trips: TripState[]) {
    for (const trip of trips) {
      if (this.labels.has(trip.tripId)) continue;
      const prefix = /^(\d{6})_/.exec(trip.tripId);
      const minutes = prefix ? Math.floor(Number(prefix[1]) / 100) : null;
      const clock =
        minutes === null
          ? ""
          : String(Math.floor(minutes / 60)).padStart(2, "0") +
            String(minutes % 60).padStart(2, "0");
      const base = `${trip.routeId}-${clock}${trip.direction}`;
      // Two trips may leave the same line in the same minute. Keep each label
      // once assigned, including while one trip disappears between polls.
      const number = (this.counts.get(base) ?? 0) + 1;
      this.counts.set(base, number);
      this.labels.set(
        trip.tripId,
        number === 1 && prefix ? base : `${base}-${number}`,
      );
    }
  }

  get(tripId: string) {
    return this.labels.get(tripId) ?? tripId;
  }
}
