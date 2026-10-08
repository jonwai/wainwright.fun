/**
 * Stands in for packages/infra/lambda/kid-routes.ts in the home-network build. There are no
 * device tokens: the local server works out the child from the client IP (core.devices) and
 * passes it in the x-local-child header, after dropping any copy the client sent.
 */
import type { APIGatewayEvent } from "../../../infra/lambda/http.js";

export const LOCAL_CHILD_HEADER = "x-local-child";

export async function extractDeviceToken(event: APIGatewayEvent, _ddb?: unknown): Promise<string | null> {
  return event.headers?.[LOCAL_CHILD_HEADER] || null;
}

export async function getDevice(_ddb: unknown, token: string): Promise<Record<string, unknown> | null> {
  return token ? { child_subdomain: token } : null;
}

export async function getPreviewChild(_ddb: unknown, _token: string): Promise<string | null> {
  return null;
}
