import { defineConfig } from "vite";

// In dev the Vite server and the Worker run on separate ports (`just dev-all`);
// proxy the Worker's API so the app can fetch("/api/...") same-origin, matching
// production where the Worker serves both the API and the built assets.
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
