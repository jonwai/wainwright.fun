import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { appsConfigPlugin } from "./scripts/vite-plugin-apps-config.js";

export default defineConfig({
  plugins: [appsConfigPlugin(), tailwindcss(), react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
    host: true,
    proxy: {
      "/pair": { target: "https://api.wainwright.fun", changeOrigin: true },
      "/kid": { target: "https://api.wainwright.fun", changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    open: true,
    host: true,
  },
});
