import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "web"),
  // Relative base: the built app works from any root — GitHub Pages
  // (/NeedMusic/) or the desktop LAN server (http://ip:17963/).
  base: "./",
  resolve: {
    alias: {
      "@core": path.resolve(__dirname, "src/core"),
      "@ui": path.resolve(__dirname, "src/ui"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist-web"),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    open: true,
  },
});
