import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@core": path.resolve(__dirname, "src/core"),
      "@ui": path.resolve(__dirname, "src/ui"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "dynamic-island": resolve(__dirname, "dynamic-island.html"),
      },
    },
  },
}));
