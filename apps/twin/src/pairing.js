/* Kid pairing for the twin SPA (plain-JS port of snacks/src/api.ts).
 *
 * Web clips on iOS have isolated storage, so the twin clip pairs separately:
 * POST /pair {code} → {token} → localStorage `wfk_device_token`.
 * All kid API calls go to https://api.wainwright.fun (VITE_API_URL or dev proxy).
 */

const TOKEN_KEY = 'wfk_device_token';
export const KID_API_URL = (import.meta.env.VITE_API_URL ?? 'https://api.wainwright.fun').replace(/\/$/, '');

export function getDeviceToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setDeviceToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing — the cookie (set by /pair) still carries the session.
  }
}

export function clearDeviceToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

/** Normalises a raw or URL-form pairing code (e.g. "https://wainwright.fun/?c=ABCD2345"). */
export function extractPairingCode(raw) {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('c') ?? url.searchParams.get('code');
    if (fromQuery) return fromQuery.toUpperCase().replace(/[^A-Z0-9]/g, '');
  } catch {
    // Not a URL — treat as a raw code.
  }
  const code = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length >= 6 ? code : null;
}

/**
 * Pairs this app to a child using a grown-up's pairing code. The token is
 * stored in this app's own localStorage (web clips on iOS each have an
 * isolated storage/cookie jar, so the twin clip pairs separately from
 * the main Wainwright app).
 */
export async function pairDevice(code) {
  const normalized = extractPairingCode(code);
  if (!normalized) throw new Error('Enter the pairing code from a grown-up');
  const response = await fetch(`${KID_API_URL}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalized }),
    credentials: 'include',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Could not pair this iPad');
  }
  if (typeof data.token === 'string') setDeviceToken(data.token);
}

export async function unpairDevice() {
  try {
    await kidFetch('/kid/unpair', { method: 'POST' });
  } catch {
    // Best effort — clear the local token regardless.
  }
  clearDeviceToken();
}

export async function kidFetch(path, init = {}) {
  const headers = new Headers(init.headers);
  const token = getDeviceToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${KID_API_URL}${path}`, { ...init, headers, credentials: 'include' });
}
