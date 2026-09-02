/**
 * api.ts — every dashboard call to the shoal API goes through here.
 *
 * When the server is bound to a non-loopback host it requires a token (see
 * server/auth.ts). The operator opens the dashboard once with `?token=…`; the
 * server turns that into an HttpOnly session cookie and the browser sends it
 * automatically from then on.
 *
 * That means this module deliberately never holds the token: it is not in
 * `sessionStorage`, not in a module variable, and not appended to URLs. An XSS
 * on the dashboard origin therefore cannot read it out and reuse it elsewhere.
 * All we do here is strip the bootstrap token from the address bar so it does
 * not linger in history or get copied into a shared link.
 *
 * On the loopback default there is no token at all and this is a thin wrapper
 * over `fetch`.
 */

/**
 * Remove `?token=…` from the address bar after the server has exchanged it for
 * the session cookie. Call once, before anything fetches.
 */
export function initApiToken(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("token")) return;
  params.delete("token");
  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}

/** `fetch` with the dashboard session cookie attached. */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { credentials: "same-origin", ...init });
}
