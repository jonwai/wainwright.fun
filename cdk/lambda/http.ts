export interface APIGatewayEvent {
  rawPath?: string;
  requestContext?: {
    http?: {
      method: string;
      path: string;
      userAgent?: string;
    };
    authorizer?: {
      jwt?: {
        claims?: Record<string, string>;
      };
    };
  };
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}

export interface APIResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded?: boolean;
}

const ALLOWED_ORIGINS = new Set([
  "https://wainwright.fun",
  "https://admin.wainwright.fun",
  "https://snacks.wainwright.fun",
  "https://tickets.wainwright.fun",
  "https://twin.wainwright.fun",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
  "http://localhost:5177",
]);

export function requestOrigin(event: APIGatewayEvent): string {
  return event.headers?.origin ?? event.headers?.Origin ?? "";
}

export function corsHeaders(event: APIGatewayEvent): Record<string, string> {
  const origin = requestOrigin(event);
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://wainwright.fun";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function json(
  event: APIGatewayEvent,
  statusCode: number,
  data: unknown,
  extra?: { cookies?: string[]; headers?: Record<string, string> },
): APIResponse {
  const response: APIResponse = {
    statusCode,
    headers: { ...corsHeaders(event), ...extra?.headers },
    body: JSON.stringify(data),
  };
  if (extra?.cookies) response.cookies = extra.cookies;
  return response;
}

export function parseBody(event: APIGatewayEvent): Record<string, unknown> {
  const raw = event.body ?? "";
  const text = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;
  return JSON.parse(text || "{}");
}

export function header(event: APIGatewayEvent, name: string): string {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === needle) return value;
  }
  return "";
}
