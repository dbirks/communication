/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev server proxies API and auth routes to a local `communication serve`
// on :8080 so the UI is same-origin in dev, exactly as it is when `serve`
// embeds ui/dist in production (ADR-0007).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        // SSE streams must not be buffered; websocket upgrade is not used.
        ws: false,
      },
      "/auth": {
        target: "http://localhost:8080",
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
  },
});
