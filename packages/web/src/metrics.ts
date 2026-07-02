import type { PredictionErrorRecord } from "./prediction-error";
import type { EstimatorReport } from "./trains";

// Dev-only sink: POST each poll's record to the Vite middleware (see
// vite.config.ts), which appends it as one JSONL line to
// packages/web/.metrics/<name>.jsonl for offline analysis. In a production build
// there is no middleware and the DEV guard tree-shakes this to a no-op.
// Fire-and-forget: a failed POST must never disturb the render loop.
function post(name: string, rec: unknown): void {
  if (!import.meta.env.DEV) return;
  void fetch(`/__metrics/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rec),
  }).catch(() => {});
}

// Frame-to-frame re-anchor jump of the STATELESS one-frame model (doc02.04).
export function logPredictionError(rec: PredictionErrorRecord): void {
  post("prediction-error", rec);
}

// The rendered estimator vs reality, and its visible re-base jumps (doc02.06).
export function logEstimatorReport(rec: EstimatorReport): void {
  post("estimator", rec);
}
