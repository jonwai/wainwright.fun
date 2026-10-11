import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { kidDevProxy } from "../../packages/shared/scripts/api-base";
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
      "/pair": kidDevProxy(),
      "/kid": kidDevProxy(),
    },
  },
  preview: {
    port: 4173,
    open: true,
    host: true,
  },
});
