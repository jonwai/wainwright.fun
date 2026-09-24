import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";
import {
  CHILD_COLOR_HEX,
  generateProfile,
  generateWebManifest,
  loadConfig,
} from "./config.js";
import { enrichConfigWithIcons } from "./icons.js";
import { signProfile, hasSigningCert } from "./sign-profile.js";
import {
  listChildSubdomains,
  parseSubdomainFromHost,
  resolveChildConfig,
  type ResolvedChildConfig,
} from "./resolve.js";
import { parseAsOfDate } from "./birthday.js";

const VIRTUAL_MODULE_ID = "virtual:apps-config";
const RESOLVED_VIRTUAL_MODULE_ID = "\0" + VIRTUAL_MODULE_ID;
const PROFILE_PATH = "/profile.mobileconfig";
const MANIFEST_PATH = "/manifest.webmanifest";
const CERT_PATH = "/signing-certificate.crt";
const CONFIG_ELEMENT_ID = "site-config";
const CONFIG_JSON_PATH = "/config.json";
const PROFILE_CONTENT_TYPE = "application/x-apple-aspen-config";
const CERT_CONTENT_TYPE = "application/x-x509-ca-cert";

const ROOT = join(import.meta.dirname, "..");
const CERT_FILE = join(ROOT, "certificates", "profile-signing.crt");

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function resolveActiveSubdomain(host: string | undefined, domain: string): string {
  const fromHost = host ? parseSubdomainFromHost(host, domain) : null;
  if (fromHost && fromHost !== "admin") {
    return fromHost;
  }

  const fromEnv = process.env.VITE_CHILD;
  if (fromEnv) {
    return fromEnv;
  }

  const subdomains = listChildSubdomains(loadConfig());
  if (subdomains.length === 0) {
    throw new Error("No children configured in apps.yaml");
  }

  return subdomains[0];
}

function parseAsOfFromUrl(url: string | undefined): Date | undefined {
  if (!url) return undefined;
  try {
    return parseAsOfDate(new URL(url, "http://localhost").searchParams.get("asOf"));
  } catch {
    return undefined;
  }
}

function serveChildAssets(
  getResolved: () => ResolvedChildConfig,
  getSubdomain: () => string
) {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split("?")[0];

    if (url === PROFILE_PATH) {
      const profile = signProfile(generateProfile(getResolved(), loadConfig().restrictions ?? []));
      res.statusCode = 200;
      res.setHeader("Content-Type", PROFILE_CONTENT_TYPE);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${getSubdomain()}-profile.mobileconfig"`
      );
      res.end(profile);
      return;
    }

    if (url === MANIFEST_PATH) {
      const manifest = generateWebManifest(getResolved());
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/manifest+json");
      res.end(manifest);
      return;
    }

    if (url === CERT_PATH) {
      if (!hasSigningCert()) {
        res.statusCode = 404;
        res.end("No signing certificate configured");
        return;
      }
      const cert = readFileSync(CERT_FILE);
      res.statusCode = 200;
      res.setHeader("Content-Type", CERT_CONTENT_TYPE);
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="profile-signing.crt"'
      );
      res.end(cert);
      return;
    }

    if (url === CONFIG_JSON_PATH) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(getResolved()));
      return;
    }

    next();
  };

  return handler;
}

/**
 * Dev-only helpers: yaml-backed config/profile when VITE_CHILD is set.
 * Production is a single SPA that loads config from the kid API after pairing.
 */
export function appsConfigPlugin(): Plugin {
  const root = join(import.meta.dirname, "..");
  const configPath = join(root, "apps.yaml");
  let profileUpdatedAt = new Date().toISOString();
  let enrichedConfigPromise = enrichConfigWithIcons(loadConfig());
  let activeSubdomain = listChildSubdomains(loadConfig())[0] ?? "dev";
  let resolvedConfig: ResolvedChildConfig | null = null;

  async function refreshConfig(): Promise<ResolvedChildConfig> {
    profileUpdatedAt = new Date().toISOString();
    const enriched = await enrichConfigWithIcons(loadConfig());
    enrichedConfigPromise = Promise.resolve(enriched);
    resolvedConfig = resolveChildConfig(
      enriched,
      activeSubdomain,
      profileUpdatedAt,
      enriched.restrictions ?? [],
    );
    return resolvedConfig;
  }

  function attachRoutes(server: ViteDevServer | PreviewServer) {
    server.middlewares.use(async (req, _res, next) => {
      const host = req.headers.host;
      try {
        const domain = loadConfig().domain;
        activeSubdomain = resolveActiveSubdomain(host, domain);
        const enriched = await enrichedConfigPromise;
        const asOf = parseAsOfFromUrl(req.url);
        resolvedConfig = resolveChildConfig(
          enriched,
          activeSubdomain,
          profileUpdatedAt,
          enriched.restrictions ?? [],
          asOf,
        );
      } catch {
        // Keep previous resolved config when host does not match.
      }
      next();
    });

    server.middlewares.use(
      serveChildAssets(
        () => {
          if (!resolvedConfig) {
            throw new Error("Config not resolved yet");
          }
          return resolvedConfig;
        },
        () => activeSubdomain
      )
    );
  }

  return {
    name: "apps-config",

    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const config = resolvedConfig;
        if (!ctx.server || !config) {
          return html
            .replace(/<title>.*?<\/title>/, "<title>Wainwright</title>")
            .replace(
              "</head>",
              `    <link rel="manifest" href="/site.webmanifest" />\n    <meta name="theme-color" content="#5b6cff" />\n    <meta name="apple-mobile-web-app-title" content="Wainwright" />\n  </head>`
            );
        }

        const themeColor = CHILD_COLOR_HEX[config.child.color];
        return html
          .replace(/<title>.*?<\/title>/, `<title>${config.site.title}</title>`)
          .replace(/<meta name="apple-mobile-web-app-title"[^>]*>/, "")
          .replace(
            "</head>",
            `    <link rel="manifest" href="/manifest.webmanifest" />\n    <meta name="theme-color" content="${themeColor}" />\n    <meta name="apple-mobile-web-app-title" content="${config.site.title}" />\n    <script id="${CONFIG_ELEMENT_ID}" type="application/json">${escapeJsonForHtml(config)}</script>\n  </head>`
          );
      },
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
    },

    async load(id) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        const enriched = await enrichedConfigPromise;
        const resolved = resolveChildConfig(
          enriched,
          activeSubdomain,
          profileUpdatedAt,
          enriched.restrictions ?? [],
        );
        return `export default ${JSON.stringify(resolved)}`;
      }
    },

    configureServer(server) {
      attachRoutes(server);

      server.watcher.add(configPath);
      server.watcher.on("change", async (file) => {
        if (file === configPath) {
          await refreshConfig();
          const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
          if (module) {
            server.reloadModule(module);
          }
          server.ws.send({ type: "full-reload" });
        }
      });
    },

    configurePreviewServer(server) {
      attachRoutes(server);
    },

    async buildStart() {
      try {
        const enriched = await enrichConfigWithIcons(loadConfig());
        enrichedConfigPromise = Promise.resolve(enriched);
        activeSubdomain = process.env.VITE_CHILD ?? activeSubdomain;
        resolvedConfig = resolveChildConfig(
          enriched,
          activeSubdomain,
          profileUpdatedAt,
          enriched.restrictions ?? [],
        );
      } catch {
        resolvedConfig = null;
      }
    },
  };
}
