import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const backendTarget = process.env.UNDERTREE_BACKEND_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: backendTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
