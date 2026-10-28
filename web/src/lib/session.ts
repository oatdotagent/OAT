/**
 * The user's personal API token, kept in sessionStorage so it is cleared when the tab closes.
 * Storage can be unavailable (private mode, blocked site data) — fall back to memory.
 */
const KEY = 'oat.apiToken';
let memory: string | null = null;

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setToken(token: string): void {
  memory = token;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* memory fallback only */
  }
}

export function clearToken(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Matches the backend's accepted bearer token charset/length. */
export function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{16,512}$/.test(value.trim());
}
