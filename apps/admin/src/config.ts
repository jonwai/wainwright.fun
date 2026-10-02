/**
 * Cognito + API configuration — injected at build time via Vite env vars.
 * The deploy script reads CloudFormation outputs and sets these.
 */
export const cognitoConfig = {
  domain: import.meta.env.VITE_COGNITO_DOMAIN,
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
  redirectUri: `${import.meta.env.VITE_ADMIN_ORIGIN ?? (import.meta.env.DEV ? "http://localhost:5174" : "https://admin.wainwright.fun")}/`,
} as const;

export const apiConfig = {
  baseUrl: import.meta.env.VITE_API_URL ?? "https://api.wainwright.fun",
} as const;
