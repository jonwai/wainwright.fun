// The home-network iPad config admin (admin.wainwright.fun served by packages/local on the Mac).
// No Cognito: the server only answers a parent's device (by IP address). See src/local-admin.tsx.
// Build: VITE_API_URL=/api vite build -c vite.local-admin.config.ts
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
  publicDir: false,
  define: { "import.meta.env.VITE_API_URL": JSON.stringify("/api") },
  build: {
    outDir: resolve(__dirname, "dist-local-admin"),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, "local-admin.html") } },
  },
});
