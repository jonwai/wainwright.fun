import { cognitoConfig } from "./config";

// ── Types ───────────────────────────────────────────────────────────

export interface AuthSession {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

// ── PKCE helpers ────────────────────────────────────────────────────

function base64UrlEncode(bytes: ArrayBuffer): string {
  const bytesArr = new Uint8Array(bytes);
  let str = "";
  for (let i = 0; i < bytesArr.length; i++) {
    str += String.fromCharCode(bytesArr[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateRandomString(length = 43): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}

async function createPkceChallenge(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = generateRandomString();
  const challenge = base64UrlEncode(await sha256(verifier));
  return { verifier, challenge };
}

// ── Storage keys ────────────────────────────────────────────────────

const PKCE_VERIFIER_KEY = "pkce_verifier";
const SESSION_KEY = "cognito_session";
const REDIRECT_PATH_KEY = "post_login_path";

function storeSession(session: AuthSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession(): AuthSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── Session refresh ──────────────────────────────────────────────────

let refreshCallback: ((session: AuthSession) => void) | null = null;

/**
 * Register a callback invoked whenever the session is refreshed.
 * Used by the React layer to update state when tokens change.
 */
export function onSessionRefreshed(cb: (session: AuthSession) => void): void {
  refreshCallback = cb;
}

let refreshPromise: Promise<AuthSession | null> | null = null;

/**
 * Refresh the access token using the stored refresh token.
 * Deduplicates concurrent calls — if a refresh is already in flight,
 * returns the same promise.
 *
 * Returns the new session on success, or null if the refresh failed
 * (caller should log out).
 */
export async function refreshSession(): Promise<AuthSession | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const session = loadSession();
    if (!session?.refreshToken) return null;

    const tokenUrl = `${cognitoConfig.domain}/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cognitoConfig.clientId,
      refresh_token: session.refreshToken,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) return null;

    const tokens = await response.json();
    const newSession: AuthSession = {
      accessToken: tokens.access_token,
      idToken: tokens.id_token ?? session.idToken,
      refreshToken: session.refreshToken, // refresh token is not rotated
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };

    storeSession(newSession);
    refreshCallback?.(newSession);
    return newSession;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Redirect the browser to the Cognito hosted UI to begin login.
 * Generates a PKCE challenge and stores the verifier in sessionStorage.
 */
export async function login(): Promise<void> {
  const { verifier, challenge } = await createPkceChallenge();
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);

  // Remember the current path so we can return to it after the OAuth redirect
  sessionStorage.setItem(REDIRECT_PATH_KEY, window.location.pathname);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cognitoConfig.clientId,
    redirect_uri: cognitoConfig.redirectUri,
    scope: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${cognitoConfig.domain}/oauth2/authorize?${params}`;
}

/**
 * Handle the OAuth callback. If `code` is present in the URL, exchange it
 * for tokens. Returns the session if successful, null otherwise.
 */
export async function handleCallback(): Promise<AuthSession | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;

  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  if (!verifier) return null;

  const tokenUrl = `${cognitoConfig.domain}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cognitoConfig.clientId,
    code,
    redirect_uri: cognitoConfig.redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    return null;
  }

  const tokens = await response.json();
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);

  const session: AuthSession = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  storeSession(session);

  // Restore the path the user was on before login (or clean the query params)
  const savedPath = sessionStorage.getItem(REDIRECT_PATH_KEY) || window.location.pathname;
  sessionStorage.removeItem(REDIRECT_PATH_KEY);
  window.history.replaceState({}, document.title, savedPath);

  return session;
}

/**
 * Get the current session if valid. Returns null if not logged in
 * or if the token has expired (caller should trigger login).
 */
export function getSession(): AuthSession | null {
  // Return the stored session even if expired — the API layer handles
  // refresh transparently on 401, and App.tsx proactively refreshes on
  // init when the token is expired.
  return loadSession();
}

/**
 * Redirect to Cognito logout endpoint, then back to the admin site.
 */
export function logout(): void {
  clearSession();

  const params = new URLSearchParams({
    client_id: cognitoConfig.clientId,
    logout_uri: cognitoConfig.redirectUri,
  });

  window.location.href = `${cognitoConfig.domain}/logout?${params}`;
}
