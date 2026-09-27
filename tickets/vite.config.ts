import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss(), react()],
  base: "/",
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "../dist/tickets"),
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    open: true,
    proxy: {
      "/pair": { target: "https://api.wainwright.fun", changeOrigin: true },
      "/kid": { target: "https://api.wainwright.fun", changeOrigin: true },
    },
  },
});
