const TOKEN_KEY = "wfk_device_token";

export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setDeviceToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearDeviceToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
