import { createHash, randomBytes, randomUUID } from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ALL_AVATARS } from "../../shared/avatars.js";
import { generateProfile, webClipSites } from "../../shared/scripts/config.js";
import { resolveChildConfig, type ResolvedChildConfig } from "../../shared/scripts/resolve.js";
import { websiteIconKeys } from "../../shared/scripts/icons.js";
import {
  buildRootConfig,
  type DbApp,
  type DbChild,
  type DbRestriction,
  type DbTheme,
  type DbWebsite,
} from "../../shared/scripts/yaml-generator.js";
import { corsHeaders, header, json, parseBody, requestOrigin, type APIGatewayEvent, type APIResponse } from "./http.js";
import { getSigningDir, signProfile } from "./profile-sign.js";

const PAIRING_TABLE = process.env.PAIRING_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const CHILDREN_TABLE = process.env.CHILDREN_TABLE!;
const APPS_TABLE = process.env.APPS_TABLE!;
const WEBSITES_TABLE = process.env.WEBSITES_TABLE!;
const THEMES_TABLE = process.env.THEMES_TABLE!;
const RESTRICTIONS_TABLE = process.env.RESTRICTIONS_TABLE!;
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://wainwright.fun";
const BUCKET_NAME = process.env.CONFIG_BUCKET_NAME;

const PAIRING_TTL_SECONDS = 10 * 60;
const PREVIEW_TTL_SECONDS = 30 * 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const s3 = new S3Client({});

async function scanAll(
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(response.Items ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateDeviceToken(): string {
  return `wfk_${randomBytes(32).toString("hex")}`;
}

function cookieValues(event: APIGatewayEvent, name: string): string[] {
  // All same-named cookies the browser sent (a device can hold several scopes:
  // host-only, Domain=.wainwright.fun, per-host — after a cookie-scope
  // change they carry different tokens; try each against the devices table).
  const prefix = `${name}=`;
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const value = decodeURIComponent(raw.slice(prefix.length).split(";")[0]);
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  };
  for (const cookie of event.cookies ?? []) {
    if (cookie.startsWith(prefix)) add(cookie);
  }
  const headerValue = header(event, "cookie");
  if (headerValue) {
    for (const part of headerValue.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) add(trimmed);
    }
  }
  return values;
}

export async function extractDeviceToken(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient
): Promise<string | null> {
  const auth = header(event, "authorization");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const fromQuery = event.queryStringParameters?.token?.trim();
  if (fromQuery) return fromQuery;
  // Cookies: a device can hold several wfk_device cookies with
  // different tokens (old host-only + new shared-domain). Try
  // each against the devices table — first valid token wins.
  for (const candidate of cookieValues(event, "wfk_device")) {
    if (await getDevice(ddb, candidate)) return candidate;
  }
  return null;
}

function requestHost(event: APIGatewayEvent): string {
  return header(event, "host").split(":")[0].toLowerCase();
}

function deviceCookie(token: string, event: APIGatewayEvent): string[] {
  // Shared-domain cookie so the Snacks Web Clip (snacks.wainwright.fun)
  // — a different host — also carries the device session. SameSite=Lax still
  // allows top-level navigations from the Home Screen clip.
  const value = encodeURIComponent(token);
  const shared = `wfk_device=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.wainwright.fun; Max-Age=31536000`;
  // Devices paired before the shared-domain cookie existed still hold a
  // host-only wfk_device cookie. A same-named cookie scoped to the
  // requesting host overwrites it, so the stale one can't shadow the fresh
  // shared token (browsers send both; first match wins server-side).
  const host = requestHost(event);
  const hostScoped = `wfk_device=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=${host}; Max-Age=31536000`;
  const hostOnly = `wfk_device=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
  return host.endsWith(".wainwright.fun") || host === "wainwright.fun"
    ? [shared, hostScoped]
    : [shared, hostOnly];
}

function clearDeviceCookie(event: APIGatewayEvent): string[] {
  // Expire every scope the cookie may exist under: shared domain,
  // per-host domain, and host-only.
  const host = requestHost(event);
  const expired = "wfk_device=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
  return [
    expired,
    `${expired}; Domain=.wainwright.fun`,
    ...((host.endsWith(".wainwright.fun") || host === "wainwright.fun")
      ? [`${expired}; Domain=${host}`]
      : []),
  ];
}

export async function getDevice(
  ddb: DynamoDBDocumentClient,
  token: string,
): Promise<Record<string, unknown> | null> {
  const response = await ddb.send(new QueryCommand({
    TableName: DEVICES_TABLE,
    IndexName: "TokenHashIndex",
    KeyConditionExpression: "token_hash = :h",
    ExpressionAttributeValues: { ":h": hashToken(token) },
    Limit: 1,
  }));
  return response.Items?.[0] ?? null;
}

async function requireDevice(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
): Promise<{ device: Record<string, unknown>; token: string } | APIResponse> {
  const token = await extractDeviceToken(event, ddb);
  if (!token) {
    return json(event, 401, { error: "Missing device token" });
  }
  const device = await getDevice(ddb, token);
  if (!device) {
    return json(event, 401, { error: "Unknown or revoked device" });
  }
  return { device, token };
}

function isAuthFailure(
  value: { device: Record<string, unknown>; token: string } | APIResponse,
): value is APIResponse {
  return "statusCode" in value;
}

async function loadResolved(
  ddb: DynamoDBDocumentClient,
  subdomain: string,
): Promise<ResolvedChildConfig> {
  const [children, apps, websites, themes, restrictions] = await Promise.all([
    scanAll(ddb, CHILDREN_TABLE),
    scanAll(ddb, APPS_TABLE),
    scanAll(ddb, WEBSITES_TABLE),
    scanAll(ddb, THEMES_TABLE),
    scanAll(ddb, RESTRICTIONS_TABLE),
  ]);

  const config = buildRootConfig({
    children: children as unknown as DbChild[],
    apps: apps as unknown as DbApp[],
    websites: websites as unknown as DbWebsite[],
    themes: themes as unknown as DbTheme[],
    restrictions: restrictions as unknown as DbRestriction[],
  });

  return resolveChildConfig(
    config,
    subdomain,
    new Date().toISOString(),
    config.restrictions ?? [],
  );
}

async function loadWebClipIconsFromS3(
  sites: { url: string; icon?: string }[],
): Promise<Map<string, Buffer>> {
  const icons = new Map<string, Buffer>();
  if (!BUCKET_NAME || sites.length === 0) {
    return icons;
  }

  await Promise.all(sites.map(async (site) => {
    for (const key of websiteIconKeys(site)) {
      try {
        const response = await s3.send(new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
        }));
        const bytes = await response.Body?.transformToByteArray();
        if (bytes && bytes.length > 0) {
          icons.set(site.url, Buffer.from(bytes));
          return;
        }
      } catch {
        // Try the next candidate key.
      }
    }
  }));

  return icons;
}

function toKidPayload(resolved: ResolvedChildConfig): Record<string, unknown> {
  const { restrictions: _restrictions, ...rest } = resolved;
  const {
    date_of_birth: _dob,
    restriction_overrides: _overrides,
    ...child
  } = rest.child;
  return { ...rest, child };
}

export async function createPairingSession(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  subdomain: string,
): Promise<APIResponse> {
  const child = await ddb.send(new GetCommand({
    TableName: CHILDREN_TABLE,
    Key: { subdomain },
  }));
  if (!child.Item) {
    return json(event, 404, { error: "Child not found" });
  }

  let code = generatePairingCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await ddb.send(new GetCommand({
      TableName: PAIRING_TABLE,
      Key: { code },
    }));
    if (!existing.Item) break;
    code = generatePairingCode();
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + PAIRING_TTL_SECONDS;
  await ddb.send(new PutCommand({
    TableName: PAIRING_TABLE,
    Item: {
      code,
      kind: "pair",
      child_subdomain: subdomain,
      created_at: now,
      ttl: expiresAt,
    },
  }));

  return json(event, 200, {
    code,
    expires_at: expiresAt * 1000,
    pairing_url: `${SITE_ORIGIN}/?c=${code}`,
    child: {
      subdomain,
      name: child.Item.name,
      avatar: child.Item.avatar,
      color: child.Item.color,
    },
  });
}

export async function createPreviewSession(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  subdomain: string,
): Promise<APIResponse> {
  const child = await ddb.send(new GetCommand({
    TableName: CHILDREN_TABLE,
    Key: { subdomain },
  }));
  if (!child.Item) {
    return json(event, 404, { error: "Child not found" });
  }

  const token = `prv_${randomBytes(24).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + PREVIEW_TTL_SECONDS;
  await ddb.send(new PutCommand({
    TableName: PAIRING_TABLE,
    Item: {
      code: token,
      kind: "preview",
      child_subdomain: subdomain,
      created_at: now,
      ttl: expiresAt,
    },
  }));

  return json(event, 200, {
    preview_url: `${SITE_ORIGIN}/?preview=${encodeURIComponent(token)}`,
    expires_at: expiresAt * 1000,
    child: {
      subdomain,
      name: child.Item.name,
      avatar: child.Item.avatar,
      color: child.Item.color,
    },
  });
}

export async function getPreviewChild(
  ddb: DynamoDBDocumentClient,
  token: string,
): Promise<string | null> {  if (!token.startsWith("prv_")) return null;
  const pairing = await ddb.send(new GetCommand({
    TableName: PAIRING_TABLE,
    Key: { code: token },
  }));
  const item = pairing.Item;
  const now = Math.floor(Date.now() / 1000);
  if (!item || item.kind !== "preview" || Number(item.ttl) < now) return null;
  return String(item.child_subdomain);
}

type ChildAccess =
  | { subdomain: string; token: string; device?: Record<string, unknown> }
  | APIResponse;

function isDenied(value: ChildAccess): value is APIResponse {
  return "statusCode" in value;
}

async function resolveChildAccess(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
  options: { allowPreview?: boolean } = {},
): Promise<ChildAccess> {
  const token = await extractDeviceToken(event, ddb);
  if (!token) {
    return json(event, 401, { error: "Missing device token" });
  }
  const device = await getDevice(ddb, token);
  if (device) {
    return { subdomain: String(device.child_subdomain), token, device };
  }
  if (options.allowPreview) {
    const subdomain = await getPreviewChild(ddb, token);
    if (subdomain) return { subdomain, token };
  }
  return json(event, 401, { error: "Unknown or revoked device" });
}

async function handlePair(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
): Promise<APIResponse> {
  const body = parseBody(event);
  const code = String(body.code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (code.length < 6) {
    return json(event, 400, { error: "Enter the pairing code from a grown-up" });
  }

  const pairing = await ddb.send(new GetCommand({
    TableName: PAIRING_TABLE,
    Key: { code },
  }));
  const item = pairing.Item;
  const now = Math.floor(Date.now() / 1000);
  if (!item || item.kind === "preview" || Number(item.ttl) < now) {
    return json(event, 400, { error: "That code is invalid or has expired" });
  }

  await ddb.send(new DeleteCommand({
    TableName: PAIRING_TABLE,
    Key: { code },
  }));

  const subdomain = String(item.child_subdomain);
  const token = generateDeviceToken();
  const deviceId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: DEVICES_TABLE,
    Item: {
      device_id: deviceId,
      token_hash: hashToken(token),
      child_subdomain: subdomain,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      user_agent: event.requestContext?.http?.userAgent ?? "",
    },
  }));

  const resolved = await loadResolved(ddb, subdomain);
  return json(event, 200, {
    token,
    device_id: deviceId,
    config: toKidPayload(resolved),
  }, {
    cookies: deviceCookie(token, event),
  });
}

async function handleKidConfig(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
): Promise<APIResponse> {
  const auth = await resolveChildAccess(event, ddb, { allowPreview: true });
  if (isDenied(auth)) return auth;

  if (auth.device) {
    await ddb.send(new UpdateCommand({
      TableName: DEVICES_TABLE,
      Key: { device_id: auth.device.device_id },
      UpdateExpression: "SET last_seen = :now",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    }));
  }

  const resolved = await loadResolved(ddb, auth.subdomain);
  // Re-set the device cookie on every config load so devices paired before the
  // shared-domain cookie existed (host-only wfk_device) upgrade to the
  // Domain=.wainwright.fun variant without re-pairing — the Snacks Web
  // Clip (snacks.wainwright.fun) needs it.
  const extra = auth.device
    ? { cookies: deviceCookie(auth.token, event) }
    : undefined;
  return json(event, 200, toKidPayload(resolved), extra);
}

async function handleKidAvatar(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
): Promise<APIResponse> {
  const auth = await resolveChildAccess(event, ddb, { allowPreview: true });
  if (isDenied(auth)) return auth;

  const body = parseBody(event);
  const avatar = String(body.avatar ?? "");
  if (!ALL_AVATARS.includes(avatar)) {
    return json(event, 400, { error: "Choose an avatar from the list" });
  }

  await ddb.send(new UpdateCommand({
    TableName: CHILDREN_TABLE,
    Key: { subdomain: auth.subdomain },
    UpdateExpression: "SET avatar = :avatar",
    ExpressionAttributeValues: { ":avatar": avatar },
  }));

  return json(event, 200, { avatar });
}

async function handleKidProfile(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
): Promise<APIResponse> {
  const auth = await resolveChildAccess(event, ddb, { allowPreview: true });
  if (isDenied(auth)) return auth;

  const subdomain = auth.subdomain;
  const resolved = await loadResolved(ddb, subdomain);
  const webClipIcons = await loadWebClipIconsFromS3(webClipSites(resolved));
  const unsigned = generateProfile(resolved, resolved.restrictions, { webClipIcons });
  const certDir = await getSigningDir();
  const profile = certDir ? signProfile(unsigned, certDir) : Buffer.from(unsigned, "utf8");

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(event),
      "Content-Type": "application/x-apple-aspen-config",
      "Content-Disposition": `attachment; filename="${subdomain}-profile.mobileconfig"`,
      "Cache-Control": "no-store",
    },
    body: profile.toString("base64"),
    isBase64Encoded: true,
  };
}

async function handleKidUnpair(
  event: APIGatewayEvent,
  ddb: DynamoDBDocumentClient,
): Promise<APIResponse> {
  const auth = await requireDevice(event, ddb);
  if (isAuthFailure(auth)) return auth;

  await ddb.send(new DeleteCommand({
    TableName: DEVICES_TABLE,
    Key: { device_id: auth.device.device_id },
  }));

  return json(event, 200, { unpaired: true }, {
    cookies: clearDeviceCookie(event),
  });
}

export async function tryHandlePublicRoute(
  event: APIGatewayEvent,
  method: string,
  resource: string,
  resourceId: string,
  ddb: DynamoDBDocumentClient,
): Promise<APIResponse | null> {
  if (method === "POST" && resource === "pair" && !resourceId) {
    return handlePair(event, ddb);
  }

  if (resource !== "kid") return null;

  if (method === "GET" && resourceId === "config") {
    return handleKidConfig(event, ddb);
  }
  if (method === "PUT" && resourceId === "avatar") {
    return handleKidAvatar(event, ddb);
  }
  if (method === "GET" && (resourceId === "profile" || resourceId === "profile.mobileconfig")) {
    return handleKidProfile(event, ddb);
  }
  if (method === "POST" && resourceId === "unpair") {
    return handleKidUnpair(event, ddb);
  }

  return json(event, 404, { error: "Not found" });
}
