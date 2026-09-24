import { defineConfig, type Plugin } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Hue bridge credentials (dev only — gitignored, stays on this Mac). */
const HUE_CREDENTIALS = resolve(
  process.env.HOME ?? "",
  "Documents/home-twin/data/hue/credentials.json",
);

/**
 * Dev-only: GET /api/hue/lights proxies the local Hue Bridge directly
 * (production uses the auth-gated sidecar on home.wainwright.fun).
 * Credentials stay server-side; response is light id → public state only.
 */
function hueLightsApi(): Plugin {
  return {
    name: "hue-lights-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (url !== "/api/hue/lights") return next();
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          return;
        }
        let creds: {
          bridge_ip?: string; ip?: string;
          username?: string; user?: string; api_key?: string; key?: string;
        };
        try {
          creds = JSON.parse(fs.readFileSync(HUE_CREDENTIALS, "utf8"));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: "credentials unavailable" }));
          return;
        }
        const ip = creds.bridge_ip || creds.ip;
        const user = creds.username || creds.user || creds.api_key || creds.key;
        if (!ip || !user) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: "credentials incomplete" }));
          return;
        }
        const request = https.request(
          {
            hostname: ip,
            port: 443,
            path: `/api/${encodeURIComponent(user)}/lights`,
            method: "GET",
            rejectUnauthorized: false,
            timeout: 4000,
          },
          (upstream) => {
            const chunks: Buffer[] = [];
            upstream.on("data", (c: Buffer) => chunks.push(c));
            upstream.on("end", () => {
              try {
                const lights = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (Array.isArray(lights) && lights[0]?.error) {
                  res.statusCode = 502;
                  res.end(JSON.stringify({ ok: false, error: "bridge error" }));
                  return;
                }
                const out: Record<string, unknown> = {};
                for (const [id, light] of Object.entries(lights)) {
                  if (!light || typeof light !== "object") continue;
                  const l = light as Record<string, unknown>;
                  const st = (l.state as Record<string, unknown>) ?? {};
                  out[id] = {
                    name: l.name ?? null,
                    type: l.type ?? null,
                    productname: l.productname ?? null,
                    modelid: l.modelid ?? null,
                    on: !!st.on,
                    bri: st.bri ?? null,
                    hue: st.hue ?? null,
                    sat: st.sat ?? null,
                    xy: st.xy ?? null,
                    ct: st.ct ?? null,
                    colormode: st.colormode ?? null,
                    reachable: st.reachable !== false,
                  };
                }
                res.setHeader("content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ lights: out }));
              } catch {
                res.statusCode = 502;
                res.end(JSON.stringify({ ok: false, error: "bad bridge response" }));
              }
            });
          },
        );
        request.on("timeout", () => {
          request.destroy();
          res.statusCode = 504;
          res.end(JSON.stringify({ ok: false, error: "bridge timeout" }));
        });
        request.on("error", () => {
          res.statusCode = 502;
          res.end(JSON.stringify({ ok: false, error: "bridge unreachable" }));
        });
        request.end();
      });
    },
  };
}

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
    proxy: {
      "/pair": { target: "https://api.wainwright.fun", changeOrigin: true },
      "/kid": { target: "https://api.wainwright.fun", changeOrigin: true },
    },
  },
  plugins: [hueLightsApi()],
});
