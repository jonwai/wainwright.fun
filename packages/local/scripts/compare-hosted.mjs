/**
 * Proves the home-network launcher and iPad profiles are what the deployed hosted API serves for
 * the same data, before wainwright.fun moves.
 *
 *   node scripts/compare-hosted.mjs --bundle <deployed Lambda index.js> --scans <dir of hosted scans> \
 *     [--database-url postgres://…] [--served http://127.0.0.1:43127]
 *
 * Hosted side: the deployed ApiStack handler bundle, run here against DynamoDB Local (docker,
 * in-memory) loaded with the hosted scans, with dummy credentials, every AWS endpoint pointed at
 * DynamoDB Local, no bucket and no signing secrets. It cannot reach AWS. A fake device per child
 * exists only in DynamoDB Local.
 * Local side: the same functions the home server uses, against Postgres (read only).
 * Served: GET /kid/config and /kid/profile from the running server with each child's iPad IP; the
 * signed profile is verified against the signing certificate and its content compared.
 *
 * Normalised before comparing: profileUpdatedAt (the request time), PayloadUUIDs (random in the
 * deployed build, stable since 6b50abc), CRLF (openssl smime -sign canonicalises line endings)
 * and Web Clip icon data (hosted reads it from the site bucket, which the harness cannot reach;
 * the icon files are checked against the bucket separately).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DDB_PORT = 8765;
const DDB = `http://127.0.0.1:${DDB_PORT}`;
const TABLES = {
  children: ["CHILDREN_TABLE", [["subdomain", "S"]]],
  apps: ["APPS_TABLE", [["bundle_id", "S"]]],
  websites: ["WEBSITES_TABLE", [["url", "S"]]],
  themes: ["THEMES_TABLE", [["from_age", "N"]]],
  restrictions: ["RESTRICTIONS_TABLE", [["key", "S"]]],
  "term-dates": ["TERM_DATES_TABLE", [["academic_year", "S"]]],
};

async function hostedSide(bundle, scans, children) {
  // Everything AWS goes to DynamoDB Local with credentials that work nowhere else.
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "harness",
    AWS_SECRET_ACCESS_KEY: "harness",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL: DDB,
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    CONFIG_BUCKET_NAME: "",
    SIGNING_CERT_SECRET: "",
    SIGNING_KEY_SECRET: "",
    SITE_ORIGIN: "https://wainwright.fun",
    DEVICES_TABLE: "harness-devices",
    PAIRING_TABLE: "harness-pairing",
  });
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;
  for (const [name, [env]] of Object.entries(TABLES)) process.env[env] = `harness-${name}`;
  const require = createRequire(path.resolve(here, "../../infra/package.json"));
  const { DynamoDBClient, CreateTableCommand, BatchWriteItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
  const ddb = new DynamoDBClient({ endpoint: DDB });
  for (const [name, [, key]] of Object.entries(TABLES)) {
    await ddb.send(new CreateTableCommand({
      TableName: `harness-${name}`,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: key.map(([n, t]) => ({ AttributeName: n, AttributeType: t })),
      KeySchema: [{ AttributeName: key[0][0], KeyType: "HASH" }],
    }));
    const items = JSON.parse(readFileSync(path.join(scans, `wainwright-${name}.json`), "utf8")).Items;
    for (let i = 0; i < items.length; i += 25) {
      await ddb.send(new BatchWriteItemCommand({ RequestItems: { [`harness-${name}`]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
    }
  }
  await ddb.send(new CreateTableCommand({
    TableName: "harness-devices",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "device_id", AttributeType: "S" }, { AttributeName: "token_hash", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "device_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{ IndexName: "TokenHashIndex", KeySchema: [{ AttributeName: "token_hash", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }],
  }));
  await ddb.send(new CreateTableCommand({ TableName: "harness-pairing", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "code", AttributeType: "S" }], KeySchema: [{ AttributeName: "code", KeyType: "HASH" }] }));
  for (const child of children) {
    const token = `harness-${child}`;
    await ddb.send(new PutItemCommand({ TableName: "harness-devices", Item: { device_id: { S: `harness-${child}` }, token_hash: { S: createHash("sha256").update(token).digest("hex") }, child_subdomain: { S: child } } }));
  }
  const { handler } = require(path.resolve(bundle));
  const out = {};
  for (const child of children) {
    const call = async (route) => {
      const response = await handler({
        rawPath: route,
        requestContext: { http: { method: "GET", path: route } },
        headers: { host: "wainwright.fun", authorization: `Bearer harness-${child}` },
        isBase64Encoded: false,
        queryStringParameters: {},
      });
      if (response.statusCode !== 200) throw new Error(`hosted ${route} for ${child}: ${response.statusCode} ${response.body}`);
      return response.isBase64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
    };
    out[child] = { config: JSON.parse(await call("/kid/config")), profile: await call("/kid/profile") };
  }
  return out;
}

async function localSide(databaseUrl, children) {
  const { default: pg } = await import("pg");
  const { loadResolved, toKidPayload, unsignedProfile, PgDocumentClient } = await import("../dist/sites.mjs");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const out = {};
  const db = await pool.connect();
  try {
    await db.query("BEGIN READ ONLY");
    for (const child of children) {
      const resolved = await loadResolved(new PgDocumentClient(db), child, new Date());
      out[child] = { config: toKidPayload(resolved), profile: await unsignedProfile(resolved, null) };
    }
    await db.query("ROLLBACK");
  } finally {
    db.release();
    await pool.end();
  }
  return out;
}

function normaliseConfig(config) {
  return JSON.stringify({ ...config, profileUpdatedAt: "<time>" }, null, 1);
}
function normaliseProfile(text) {
  return text
    .replaceAll("\r\n", "\n")
    .replace(/(<key>PayloadUUID<\/key>\s*<string>)[0-9A-Fa-f-]{36}(<\/string>)/g, "$1<uuid>$2")
    .replace(/\s*<key>Icon<\/key>\s*<data>[\s\S]*?<\/data>/g, "");
}
function firstDifference(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) return `line ${i + 1}: hosted ${JSON.stringify(al[i])} local ${JSON.stringify(bl[i])}`;
  return null;
}

const side = arg("--side");
if (side) {
  const children = JSON.parse(arg("--children"));
  const result = side === "hosted" ? await hostedSide(arg("--bundle"), arg("--scans"), children) : await localSide(arg("--database-url"), children);
  writeFileSync(arg("--out"), JSON.stringify(result));
  process.exit(0);
}

// Parent: start DynamoDB Local, run both sides, fetch what the server serves, compare.
const bundle = arg("--bundle");
const scans = arg("--scans");
const databaseUrl = arg("--database-url", "postgres://wainsburys:wainsburys@127.0.0.1:5432/wainsburys");
const served = arg("--served", "http://127.0.0.1:43127");
const certFile = arg("--cert", path.join(os.homedir(), ".config/wainwright-fun/profile-signing-cert.pem"));
if (!bundle || !scans) throw new Error("usage: compare-hosted --bundle <index.js> --scans <dir>");
const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const kidIps = Object.fromEntries((await pool.query("SELECT d.person_id, host(d.ip) AS ip FROM core.devices d JOIN core.people p ON p.id = d.person_id WHERE p.role = 'child' ORDER BY d.ip")).rows.map((r) => [r.person_id, r.ip]));
await pool.end();
const children = JSON.parse(readFileSync(path.join(scans, "wainwright-children.json"), "utf8")).Items.map((i) => i.subdomain.S).sort();
const tmp = mkdtempSync(path.join(os.tmpdir(), "compare-hosted-"));
const container = `compare-hosted-ddb-${process.pid}`;
execFileSync("docker", ["run", "-d", "--rm", "--name", container, "-p", `127.0.0.1:${DDB_PORT}:8000`, "amazon/dynamodb-local", "-jar", "DynamoDBLocal.jar", "-inMemory"], { stdio: "ignore" });
const report = { children: {}, ok: true };
try {
  for (let i = 0; i < 40; i++) {
    if (spawnSync("curl", ["-s", "-o", "/dev/null", DDB]).status === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const run = (which, extra) => {
    const out = path.join(tmp, `${which}.json`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--side", which, "--children", JSON.stringify(children), "--out", out, ...extra], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env } });
    if (result.status !== 0) throw new Error(`${which} side failed`);
    return JSON.parse(readFileSync(out, "utf8"));
  };
  const hosted = run("hosted", ["--bundle", bundle, "--scans", scans]);
  const local = run("local", ["--database-url", databaseUrl]);
  for (const child of children) {
    const entry = {};
    const hc = normaliseConfig(hosted[child].config);
    entry.config = hc === normaliseConfig(local[child].config) ? "same" : `DIFFERENT: ${firstDifference(hc, normaliseConfig(local[child].config))}`;
    const hp = normaliseProfile(hosted[child].profile);
    entry.profile = hp === normaliseProfile(local[child].profile) ? "same" : `DIFFERENT: ${firstDifference(hp, normaliseProfile(local[child].profile))}`;
    const ip = kidIps[child];
    if (ip) {
      const host = ["-H", "Host: wainwright.fun", "-H", `X-Real-IP: ${ip}`];
      const config = spawnSync("curl", ["-sf", ...host, `${served}/kid/config`], { encoding: "utf8" });
      entry.servedConfig = config.status !== 0 ? "FETCH FAILED" : normaliseConfig(JSON.parse(config.stdout)) === hc ? "same" : `DIFFERENT: ${firstDifference(hc, normaliseConfig(JSON.parse(config.stdout)))}`;
      const file = path.join(tmp, `${child}.mobileconfig`);
      const profile = spawnSync("curl", ["-sf", "-o", file, ...host, `${served}/kid/profile`]);
      if (profile.status !== 0) entry.servedProfile = "FETCH FAILED";
      else {
        const verified = spawnSync("openssl", ["smime", "-verify", "-inform", "DER", "-in", file, "-CAfile", certFile, "-purpose", "any"], { encoding: "utf8" });
        if (verified.status !== 0) entry.servedProfile = "SIGNATURE DID NOT VERIFY";
        else {
          const content = verified.stdout;
          entry.servedProfile = normaliseProfile(content) === hp ? "same, signed by the profile signing certificate" : `DIFFERENT: ${firstDifference(hp, normaliseProfile(content))}`;
          entry.webClipIcons = (content.match(/<key>Icon<\/key>/g) ?? []).length;
          const clips = content.split("<string>com.apple.webClip.managed</string>").slice(1);
          entry.webClips = clips.length;
          entry.webClipsWithoutIcon = clips.filter((c) => !c.split("</dict>")[0].includes("<key>Icon</key>")).map((c) => c.match(/<key>URL<\/key>\s*<string>([^<]*)<\/string>/)?.[1]);
        }
      }
    } else entry.served = "no iPad IP for this child";
    entry.apps = hosted[child].config.apps.length + hosted[child].config.system_apps.length;
    entry.websites = hosted[child].config.websites.length;
    report.children[child] = entry;
    if (Object.values(entry).some((v) => typeof v === "string" && /DIFFERENT|FAILED|DID NOT/.test(v))) report.ok = false;
  }
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
