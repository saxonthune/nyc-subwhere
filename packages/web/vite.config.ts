import { appendFile, mkdir } from "node:fs/promises";
import { type Plugin, defineConfig } from "vite";

// Dev-only sink for the prediction-error metric (doc02.04). The client POSTs one
// record per poll to /__metrics/prediction-error; we append it as JSONL to
// .metrics/prediction-error.jsonl (gitignored) for offline analysis. `serve`
// only — a production build carries no such endpoint.
function metricsSink(): Plugin {
  const dir = new URL("./.metrics/", import.meta.url);
  const file = new URL("./.metrics/prediction-error.jsonl", import.meta.url);
  return {
    name: "metrics-sink",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__metrics/prediction-error", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          try {
            await mkdir(dir, { recursive: true });
            await appendFile(
              file,
              `${Buffer.concat(chunks).toString("utf8")}\n`,
            );
            res.statusCode = 204;
          } catch {
            res.statusCode = 500;
          }
          res.end();
        });
      });
    },
  };
}

// In dev the Vite server and the Worker run on separate ports (`just dev-all`);
// proxy the Worker's API so the app can fetch("/api/...") same-origin, matching
// production where the Worker serves both the API and the built assets.
export default defineConfig({
  plugins: [metricsSink()],
  server: {
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
