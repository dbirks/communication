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
