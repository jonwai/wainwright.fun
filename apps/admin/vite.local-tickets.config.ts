// The home-network tickets admin (see src/local-tickets.tsx). No Cognito: the local server
// decides by IP address. Build: VITE_API_URL=/api vite build -c vite.local-tickets.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss(), react()],
  base: "/admin/",
  publicDir: resolve(__dirname, "../../public"),
  build: {
    outDir: resolve(__dirname, "dist-local-tickets"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "local-tickets.html") },
  },
});
