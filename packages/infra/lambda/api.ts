/**
 * API Lambda handler for wainwright.fun.
 *
 * Bundle marker v2.2 — school/non-school day budget amounts (no item cap)
 * + term-dates routes. (Marker included so asset-hash changes force a fresh
 * bundle deploy.)
 *
 * Admin (Cognito JWT):
 *   GET    /me
 *   GET    /icons
 *   GET    /config
 *   CRUD   /children /apps /websites /themes /restrictions
 *   POST   /children/{subdomain}/pair
 *   POST   /children/{subdomain}/preview
 *   POST   /rebuild
 *
 * Kids (device token, no Cognito):
 *   POST   /pair
 *   GET    /kid/config
 *   PUT    /kid/avatar
 *   GET    /kid/profile
 *   POST   /kid/unpair
 */

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import yaml from "js-yaml";
import { json, parseBody, type APIGatewayEvent, type APIResponse } from "./http.js";
import { createPairingSession, createPreviewSession, tryHandlePublicRoute } from "./kid-routes.js";
import { tryHandleBudgetRoute } from "./budget-routes.js";
import { buildRootConfig, type DbChild, type DbApp, type DbWebsite, type DbTheme, type DbRestriction } from "../../shared/scripts/yaml-generator.js";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET_NAME = process.env.CONFIG_BUCKET_NAME!;
const ICON_QUEUE_URL = process.env.ICON_QUEUE_URL!;
const REBUILD_QUEUE_URL = process.env.REBUILD_QUEUE_URL!;
const CHILDREN_TABLE = process.env.CHILDREN_TABLE!;
const APPS_TABLE = process.env.APPS_TABLE!;
const WEBSITES_TABLE = process.env.WEBSITES_TABLE!;
const THEMES_TABLE = process.env.THEMES_TABLE!;
const RESTRICTIONS_TABLE = process.env.RESTRICTIONS_TABLE!;

async function scanAll(tableName: string): Promise<Record<string, unknown>[]> {
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

async function generateYaml(): Promise<string> {
  const [children, apps, websites, themes, restrictions] = await Promise.all([
    scanAll(CHILDREN_TABLE),
    scanAll(APPS_TABLE),
    scanAll(WEBSITES_TABLE),
    scanAll(THEMES_TABLE),
    scanAll(RESTRICTIONS_TABLE),
  ]);

  const config = buildRootConfig({
    children: children as unknown as DbChild[],
    apps: apps as unknown as DbApp[],
    websites: websites as unknown as DbWebsite[],
    themes: themes as unknown as DbTheme[],
    restrictions: restrictions as unknown as DbRestriction[],
  });

  return yaml.dump(config, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
}

async function triggerIconFetch(app?: { bundleId: string; appStoreUrl?: string }): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: ICON_QUEUE_URL,
      MessageBody: JSON.stringify(
        app
          ? { action: "fetch-icon", bundleId: app.bundleId, appStoreUrl: app.appStoreUrl }
          : { action: "fetch-all-icons" }
      ),
    })
  );
}

async function listIcons(prefix: string): Promise<string[]> {
  const response = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix })
  );
  return (response.Contents ?? [])
    .map((obj) => obj.Key!)
    .filter(Boolean)
    .filter((key) => !key.endsWith("/.gitkeep"))
    .map((key) => key.replace(`${prefix}/`, ""));
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  try {
    return await dispatch(event);
  } catch (err) {
    console.error("Unhandled API error:", err);
    return json(event, 500, { error: "Something went wrong" });
  }
};

async function dispatch(event: APIGatewayEvent): Promise<APIResponse> {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const method = event.requestContext?.http?.method ?? "GET";

  if (method === "OPTIONS") {
    return json(event, 204, {});
  }

  const trimmedPath = (path.startsWith("/") ? path.slice(1) : path);
  const slashIndex = trimmedPath.indexOf("/");
  const resource = slashIndex === -1 ? trimmedPath : trimmedPath.slice(0, slashIndex);
  const resourceId = slashIndex === -1 ? "" : trimmedPath.slice(slashIndex + 1);

  try {
    // Budget routes first — tryHandlePublicRoute 404s any unmatched /kid/*
    // path, so it must not run before the budget router gets a chance.
    const budgetResponse = await tryHandleBudgetRoute(event, method, resource, resourceId, ddb);
    if (budgetResponse) return budgetResponse;
  } catch (err) {
    console.error("Budget route failed:", err);
    return json(event, 500, { error: "Something went wrong" });
  }

  try {
    const publicResponse = await tryHandlePublicRoute(event, method, resource, resourceId, ddb);
    if (publicResponse) return publicResponse;
  } catch (err) {
    console.error("Public route failed:", err);
    return json(event, 500, { error: "Something went wrong" });
  }

  if (method === "GET" && resource === "me") {
    const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
    return json(event, 200, {
      username: claims["username"] ?? claims["cognito:username"] ?? "unknown",
      email: claims["email"] ?? "unknown",
      sub: claims["sub"] ?? "unknown",
      groups: (claims["cognito:groups"] ?? "").split(",").filter(Boolean),
      tokenUse: claims["token_use"] ?? "unknown",
      issuedAt: claims["iat"] ?? null,
      expiresAt: claims["exp"] ?? null,
    });
  }

  if (method === "GET" && resource === "icons") {
    try {
      const [appIcons, websiteIcons, systemIcons] = await Promise.all([
        listIcons("app-icons"),
        listIcons("website-icons"),
        listIcons("system-icons"),
      ]);
      return json(event, 200, { appIcons, websiteIcons, systemIcons });
    } catch (err) {
      console.error("Failed to list icons:", err);
      return json(event, 500, { error: "Failed to list icons" });
    }
  }

  if (method === "GET" && resource === "config") {
    try {
      const content = await generateYaml();
      return json(event, 200, { content });
    } catch (err) {
      console.error("Failed to generate config:", err);
      return json(event, 500, { error: "Failed to generate config" });
    }
  }

  if (resource === "children") {
    if (method === "GET" && !resourceId) {
      const items = await scanAll(CHILDREN_TABLE);
      items.sort((a, b) => (a.name as string).localeCompare(b.name as string));
      return json(event, 200, items.map((c) => ({ ...c, locked: c.locked !== false })));
    }

    const [childId, action] = resourceId.split("/");
    if (method === "POST" && childId && action === "pair") {
      return createPairingSession(event, ddb, childId);
    }
    if (method === "POST" && childId && action === "preview") {
      return createPreviewSession(event, ddb, childId);
    }

    if (method === "PUT" && childId && !action) {
      const body = parseBody(event);
      const item: Record<string, unknown> = {
        subdomain: childId,
        name: body.name as string ?? "",
        date_of_birth: body.date_of_birth as string ?? "",
        color: body.color as string ?? "blue",
        avatar: body.avatar as string | undefined,
        locked: body.locked !== false,
      };
      if (body.restriction_overrides) item.restriction_overrides = body.restriction_overrides;
      if (body.blocked_apps) item.blocked_apps = body.blocked_apps;
      await ddb.send(new PutCommand({ TableName: CHILDREN_TABLE, Item: item }));
      return json(event, 200, item);
    }

    if (method === "DELETE" && childId && !action) {
      await ddb.send(new DeleteCommand({
        TableName: CHILDREN_TABLE,
        Key: { subdomain: childId },
      }));
      return json(event, 200, { deleted: true });
    }
  }

  if (resource === "apps") {
    if (method === "GET" && !resourceId) {
      const type = event.queryStringParameters?.type;
      let items = await scanAll(APPS_TABLE);
      if (type) {
        items = items.filter((a) => a.type === type);
      }
      items.sort((a, b) => (a.name as string).localeCompare(b.name as string));
      return json(event, 200, items);
    }

    if (method === "PUT" && resourceId) {
      const body = parseBody(event);
      const item = {
        bundle_id: resourceId,
        name: body.name ?? "",
        type: body.type ?? "app",
        app_store_url: body.app_store_url as string | undefined,
        category: body.category as string | undefined,
        icon: body.icon as string | undefined,
        show_on_site: body.show_on_site ?? false,
        min_age: body.min_age ?? 0,
        enabled: body.enabled ?? true,
      };
      await ddb.send(new PutCommand({ TableName: APPS_TABLE, Item: item }));
      if (item.app_store_url) {
        try { await triggerIconFetch({ bundleId: item.bundle_id, appStoreUrl: item.app_store_url }); } catch (e) { console.error("SQS trigger failed:", e); }
      }
      return json(event, 200, item);
    }

    if (method === "DELETE" && resourceId) {
      await ddb.send(new DeleteCommand({
        TableName: APPS_TABLE,
        Key: { bundle_id: resourceId },
      }));
      return json(event, 200, { deleted: true });
    }
  }

  if (resource === "websites") {
    if (method === "GET" && !resourceId) {
      const items = await scanAll(WEBSITES_TABLE);
      items.sort((a, b) => (a.name as string).localeCompare(b.name as string));
      return json(event, 200, items);
    }

    if (method === "PUT" && resourceId) {
      const body = parseBody(event);
      const item: Record<string, unknown> = {
        url: decodeURIComponent(resourceId),
        name: body.name ?? "",
        icon: body.icon ?? undefined,
        category: body.category as string | undefined,
        min_age: body.min_age ?? 0,
        enabled: body.enabled ?? true,
      };
      if (body.child_subdomain) item.child_subdomain = body.child_subdomain;
      await ddb.send(new PutCommand({ TableName: WEBSITES_TABLE, Item: item }));
      try { await triggerIconFetch({ bundleId: item.url as string, appStoreUrl: undefined }); } catch (e) { console.error("SQS trigger failed:", e); }
      return json(event, 200, item);
    }

    if (method === "DELETE" && resourceId) {
      await ddb.send(new DeleteCommand({
        TableName: WEBSITES_TABLE,
        Key: { url: decodeURIComponent(resourceId) },
      }));
      return json(event, 200, { deleted: true });
    }
  }

  if (resource === "themes") {
    if (method === "GET" && !resourceId) {
      const items = await scanAll(THEMES_TABLE);
      items.sort((a, b) => (a.from_age as number) - (b.from_age as number));
      return json(event, 200, items);
    }

    if (method === "PUT" && resourceId) {
      const body = parseBody(event);
      const item: Record<string, unknown> = {
        from_age: Number(resourceId),
        theme: body.theme ?? "little",
        subtitle: body.subtitle ?? "",
      };
      if (body.restriction_overrides) item.restriction_overrides = body.restriction_overrides;
      await ddb.send(new PutCommand({ TableName: THEMES_TABLE, Item: item }));
      return json(event, 200, item);
    }

    if (method === "DELETE" && resourceId) {
      await ddb.send(new DeleteCommand({
        TableName: THEMES_TABLE,
        Key: { from_age: Number(resourceId) },
      }));
      return json(event, 200, { deleted: true });
    }
  }

  if (resource === "restrictions") {
    if (method === "GET" && !resourceId) {
      const items = await scanAll(RESTRICTIONS_TABLE);
      items.sort((a, b) => (a.key as string).localeCompare(b.key as string));
      return json(event, 200, items);
    }

    if (method === "PUT" && resourceId) {
      const body = parseBody(event);
      const item: Record<string, unknown> = {
        key: resourceId,
        value: body.value,
        type: body.type ?? "boolean",
      };
      if (body.overridable !== undefined) item.overridable = body.overridable;
      await ddb.send(new PutCommand({ TableName: RESTRICTIONS_TABLE, Item: item }));
      return json(event, 200, item);
    }

    if (method === "DELETE" && resourceId) {
      await ddb.send(new DeleteCommand({
        TableName: RESTRICTIONS_TABLE,
        Key: { key: resourceId },
      }));
      return json(event, 200, { deleted: true });
    }
  }

  if (method === "POST" && resource === "rebuild") {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: REBUILD_QUEUE_URL,
          MessageBody: JSON.stringify({ action: "rebuild", timestamp: Date.now() }),
        })
      );
      return json(event, 202, { message: "Rebuild triggered" });
    } catch (err) {
      console.error("Failed to trigger rebuild:", err);
      return json(event, 500, { error: "Failed to trigger rebuild" });
    }
  }

  return json(event, 404, { error: "Not found", path, method });
}
