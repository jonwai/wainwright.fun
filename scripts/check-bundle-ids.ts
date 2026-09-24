import { loadConfig } from "./config.js";

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

function collectBundleIds(): Array<{ name: string; bundle_id: string; source: string }> {
  const config = loadConfig();
  const entries: Array<{ name: string; bundle_id: string; source: string }> = [];

  for (const app of config.system_apps) {
    entries.push({
      name: app.name,
      bundle_id: app.bundle_id,
      source: "system_apps",
    });
  }

  for (const app of config.apps) {
    entries.push({
      name: app.name,
      bundle_id: app.bundle_id,
      source: `apps (min_age ${app.min_age})`,
    });
  }

  return entries;
}

const entries = collectBundleIds();
const seen = new Map<string, string>();
const problems: string[] = [];

for (const entry of entries) {
  if (!entry.bundle_id) {
    problems.push(`"${entry.name}" (${entry.source}) is missing bundle_id`);
    continue;
  }

  if (!BUNDLE_ID_PATTERN.test(entry.bundle_id)) {
    problems.push(
      `"${entry.name}" has invalid bundle_id "${entry.bundle_id}" (${entry.source})`
    );
  }

  const previous = seen.get(entry.bundle_id);
  if (previous && previous !== entry.name) {
    problems.push(
      `Duplicate bundle_id "${entry.bundle_id}" for "${previous}" and "${entry.name}"`
    );
  }
  seen.set(entry.bundle_id, entry.name);
}

if (problems.length > 0) {
  console.error("Bundle ID check failed:\n");
  for (const problem of problems) {
    console.error(`  • ${problem}`);
  }
  process.exit(1);
}

console.log(`Bundle ID check passed (${entries.length} entries, ${seen.size} unique IDs).`);
