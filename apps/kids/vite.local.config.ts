// The home-network launcher (wainwright.fun served by packages/local on the Mac): the device's IP
// decides the child, so there is no pairing and no per-child build. Unlike vite.config.ts this
// skips the apps-config plugin (it loads apps.yaml and fetches App Store icons on every build);
// only its production <head> changes are kept.
// Build: VITE_LOCAL_AUTH=1 vite build -c vite.local.config.ts
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const head: Plugin = {
  name: "local-head",
  transformIndexHtml: {
    order: "pre",
    handler: (html) =>
      html
        .replace(/<title>.*?<\/title>/, "<title>Wainwright</title>")
        .replace(
          "</head>",
          `    <link rel="manifest" href="/site.webmanifest" />\n    <meta name="theme-color" content="#5b6cff" />\n    <meta name="apple-mobile-web-app-title" content="Wainwright" />\n  </head>`,
        ),
  },
};

export default defineConfig({
  root: __dirname,
  plugins: [head, tailwindcss(), react()],
  publicDir: resolve(__dirname, "../../public"),
  define: { "import.meta.env.VITE_LOCAL_AUTH": JSON.stringify("1") },
  build: {
    outDir: resolve(__dirname, "dist-local"),
    emptyOutDir: true,
  },
});
