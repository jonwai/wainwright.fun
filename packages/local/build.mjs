// Bundles the home-network tickets server. The hosted task routes are bundled as they are; their
// kid-routes and budget-routes imports resolve to ./src/shims (IP identity, no Wainsbury's API).
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lambda = path.resolve(here, "../infra/lambda");
const shims = { "./kid-routes.js": "src/shims/kid-routes.ts", "./budget-routes.js": "src/shims/budget-routes.ts" };

const shimPlugin = {
  name: "home-network-shims",
  setup(b) {
    b.onResolve({ filter: /^\.\/(kid-routes|budget-routes)\.js$/ }, (args) => {
      if (path.dirname(args.importer) !== lambda) return undefined;
      return { path: path.resolve(here, shims[args.path]) };
    });
  },
};

await build({
  entryPoints: { main: "src/main.ts", app: "src/app.ts", "import-hosted": "src/import-hosted.ts", migrate: "src/migrate.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  splitting: true,
  keepNames: true,
  external: ["pg-native"],
  // Resolve the hosted handlers' AWS SDK imports from packages/infra.
  nodePaths: [path.resolve(here, "node_modules"), path.resolve(here, "../infra/node_modules")],
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  plugins: [shimPlugin],
  logLevel: "warning",
});
console.log("built dist/");
