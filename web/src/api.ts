/**
 * api.ts — every dashboard call to the shoal API goes through here.
 *
 * When the server is bound to a non-loopback host it requires a token (see
 * server/auth.ts). The operator opens the dashboard with `?token=…`; we keep it
 * for the session and attach it to each request. On the loopback default there
 * is no token and this is a thin wrapper over `fetch`.
 *
 * sessionStorage, not localStorage: the token should not outlive the tab.
 */

const STORAGE_KEY = "shoal.token";

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode / blocked storage — fall back to the in-memory copy.
    return null;
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* in-memory only */
  }
}

let token: string | null = null;

/**
 * Pick up `?token=…` from the URL, then strip it from the address bar so the
 * token does not sit in history or get copied into a shared link.
 */
export function initApiToken(): void {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    token = fromUrl;
    storeToken(fromUrl);
    params.delete("token");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    return;
  }
  token = readStoredToken();
}

export function getApiToken(): string | null {
  return token ?? readStoredToken();
}

/** Append the token to a URL — for EventSource and links, which cannot set headers. */
export function withToken(url: string): string {
  const current = getApiToken();
  if (!current) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(current)}`;
}

/** `fetch` with the dashboard token attached. */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const current = getApiToken();
  if (!current) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set("X-Shoal-Token", current);
  return fetch(input, { ...init, headers });
}
