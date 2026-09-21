import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Never inline ?url assets as data: URLs: AudioWorklet modules must be
    // real same-origin files (a data: URL worklet is rejected), and the WASM
    // must stay a separate fetchable file for lazy loading.
    assetsInlineLimit: 0,
  },
});
