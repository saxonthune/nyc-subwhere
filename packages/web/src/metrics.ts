import type { PredictionErrorRecord } from "./prediction-error";

// Dev-only sink: POST each poll's record to the Vite middleware (see
// vite.config.ts), which appends it as one JSONL line to
// packages/web/.metrics/prediction-error.jsonl for offline analysis. In a
// production build there is no middleware and the DEV guard tree-shakes this to
// a no-op. Fire-and-forget: a failed POST must never disturb the render loop.
export function logPredictionError(rec: PredictionErrorRecord): void {
  if (!import.meta.env.DEV) return;
  void fetch("/__metrics/prediction-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rec),
  }).catch(() => {});
}
