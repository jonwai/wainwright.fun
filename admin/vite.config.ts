import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // The admin SPA is unusable without Cognito: a bundle built without these
  // silently ships a login page that can never authenticate. deploy.sh sets
  // them from CloudFormation outputs; a bare `npm run build:admin` does not.
  // Dev: warn loudly but don't fail (dev may run without AWS credentials);
  // `npm run dev:admin` fetches the values, `dev:admin:raw` is the escape hatch.
  if (mode === "development") {
    const missing = ["VITE_COGNITO_DOMAIN", "VITE_COGNITO_CLIENT_ID", "VITE_API_URL"].filter(
      (key) => !process.env[key],
    );
    if (missing.length > 0) {
      console.warn(
        `\n⚠ admin dev server is missing ${missing.join(", ")} — the login page ` +
          `will NOT be able to authenticate, and API calls will fall back to ` +
          `the production URL. Run \`npm run dev:admin\` (fetches them from ` +
          `CloudFormation) instead of \`dev:admin:raw\`.\n`,
      );
    }
  }
  if (mode === "production") {
    const missing = ["VITE_COGNITO_DOMAIN", "VITE_COGNITO_CLIENT_ID", "VITE_API_URL"].filter(
      (key) => !process.env[key],
    );
    if (missing.length > 0) {
      throw new Error(
        `admin build is missing required env vars: ${missing.join(", ")}. ` +
          `Fetch them from CloudFormation outputs (see scripts/deploy.sh) or run ` +
          `\`npm run deploy\`.`,
      );
    }
  }
  return {
    root: __dirname,
    plugins: [tailwindcss(), react()],
    base: "/",
    publicDir: resolve(__dirname, "../public"),
    build: {
      outDir: resolve(__dirname, "../dist/admin"),
      emptyOutDir: true,
    },
    server: {
      port: 5174,
      open: true,
    },
  };
});
