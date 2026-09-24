import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  base: "/twin/",
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "../dist/twin"),
    emptyOutDir: true,
    target: "es2022", // main.js uses top-level await
  },
  server: {
    port: 5177,
    host: true, // phones/tablets on the LAN
  },
});
