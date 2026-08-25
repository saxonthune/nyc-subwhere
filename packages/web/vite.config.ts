import { appendFile, mkdir } from "node:fs/promises";
import { type Plugin, defineConfig } from "vite";

// Dev-only sink for the metric streams (doc02.04, doc02.06). The client POSTs one
// record per poll to /__metrics/<name> (e.g. prediction-error, estimator); we
// append it as JSONL to .metrics/<name>.jsonl (gitignored) for offline analysis.
// `serve` only — a production build carries no such endpoint.
function metricsSink(): Plugin {
  const dir = new URL("./.metrics/", import.meta.url);
  return {
    name: "metrics-sink",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__metrics/", (req, res) => {
        // Connect strips the mount prefix, so req.url is "/<name>".
        const name = (req.url ?? "").replace(/^\//, "").split(/[?#]/)[0];
        if (req.method !== "POST" || !/^[a-z0-9-]+$/.test(name)) {
          res.statusCode = req.method === "POST" ? 404 : 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          try {
            await mkdir(dir, { recursive: true });
            await appendFile(
              new URL(`./.metrics/${name}.jsonl`, import.meta.url),
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
    // Listen on the LAN too, so a phone on the same network can load the dev
    // server. The /api proxy runs on this machine, so remote clients still
    // reach the local Worker through it.
    host: true,
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
