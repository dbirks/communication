/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The compose lab exposes its round-robin load balancer on :18080 (replicas on
// :18081/:18082), so dev requests are proxied there and the UI stays
// same-origin, exactly as it is when `serve` embeds ui/dist in production
// (ADR-0007). Because everything is same-origin, cookies and the CSRF header
// behave identically in dev and in the embedded build.
const apiTarget = "http://localhost:18080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // SSE streams must not be buffered; websocket upgrade is not used.
        ws: false,
        // The CSRF middleware applies strict origin checks (06-collaboration
        // -identity), and behind this proxy the browser's origin (the dev
        // server) is not the API's own. Rewrite it to the target — dev-only
        // behavior, production embeds the SPA on the same origin (ADR-0007).
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", apiTarget);
          });
        },
      },
      "/auth": {
        target: apiTarget,
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
