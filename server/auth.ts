/**
 * auth.ts — who may drive the dashboard.
 *
 * The dashboard is not a passive viewer: `POST /api/runs/start` spawns a
 * process with a caller-supplied target URL and LLM endpoint, and the log and
 * findings endpoints return whatever the swarm saw inside the target app. That
 * is not something to leave open to a network.
 *
 * Two layers:
 *
 * 1. Binding — loopback by default (`SHOAL_HOST` to change). Before this,
 *    `app.listen(PORT)` bound every interface, so anyone who could route to the
 *    machine could start runs.
 * 2. Token — required whenever the server is bound anywhere but loopback. Set
 *    `SHOAL_TOKEN`, or one is generated and printed at startup.
 *
 * Plus a Host check on every request, because "bound to loopback" alone does
 * not stop DNS rebinding: a page on the public internet can resolve its own
 * hostname to 127.0.0.1 and reach a loopback server from the victim's browser.
 * Requiring the Host header to name a loopback address (or the configured host)
 * closes that, and the Origin check below stops ordinary cross-site calls.
 *
 * A TLS-terminating reverse proxy in front of a loopback bind (the setup
 * SECURITY.md recommends) breaks both checks unless the operator names the
 * public hostname: a proxy that preserves the Host header sends one the Host
 * check has never heard of, and a proxy that rewrites Host to the upstream
 * address (nginx's default) still forwards the browser's real `Origin`
 * unchanged, which then fails to match the rewritten Host. `SHOAL_ALLOWED_HOSTS`
 * (see `resolveAllowedHosts`) is the operator naming that hostname explicitly —
 * unset, behavior is identical to before.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

export interface Binding {
  host: string;
  port: number;
  isLoopback: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  // 127.0.0.0/8 is all loopback
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function resolveBinding(env: NodeJS.ProcessEnv = process.env): Binding {
  const host = (env.SHOAL_HOST ?? "").trim() || "127.0.0.1";
  const parsedPort = Number((env.PORT ?? "").trim() || "4000");
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 4000;
  return { host, port, isLoopback: isLoopbackHost(host) };
}

/**
 * Hostnames a reverse proxy is trusted to front the dashboard as, from
 * `SHOAL_ALLOWED_HOSTS` (comma-separated, e.g. `shoal.example.com`). A port
 * suffix is stripped — the proxy's public port (443) and shoal's internal
 * one (4000) are expected to differ. Empty when unset, which reproduces the
 * exact pre-existing behavior: no additional host is trusted.
 */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = (env.SHOAL_ALLOWED_HOSTS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean),
  );
}

/**
 * Refuse to serve on a network interface unless the operator has said so.
 *
 * The listener is plain HTTP. On a non-loopback binding the bootstrap URL and
 * the session cookie therefore cross the network in cleartext, and a warning
 * printed after the fact does not stop an accidental `SHOAL_HOST=0.0.0.0` in a
 * container or a copied command line. Making external exposure an explicit
 * decision costs one environment variable and removes the accident.
 *
 * shoal still does not terminate TLS itself — certificates belong to a reverse
 * proxy. `SHOAL_ALLOW_INSECURE=1` means "there is TLS in front of this, or I
 * accept cleartext on this network".
 */
export function assertBindingAllowed(
  binding: Binding,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (binding.isLoopback) return;
  if ((env.SHOAL_ALLOW_INSECURE ?? "").trim() === "1") return;

  throw new Error(
    `[auth] refusing to bind to ${binding.host}: the dashboard listener is plain HTTP, so the ` +
      "token and session cookie would cross the network in cleartext.\n" +
      "       Put a TLS-terminating reverse proxy in front of it, or use an SSH tunnel\n" +
      "       (ssh -L 4000:localhost:4000 host) and leave SHOAL_HOST unset.\n" +
      "       If TLS is already terminated in front of this, or you accept cleartext on this\n" +
      "       network, set SHOAL_ALLOW_INSECURE=1 to proceed.",
  );
}

export interface TokenDecision {
  /** The token requests must present, or null when none is required. */
  token: string | null;
  /** True when shoal generated it and must print it for the operator. */
  generated: boolean;
  /** Lines to log at startup. */
  notices: string[];
}

const MIN_TOKEN_LENGTH = 16;

/**
 * Decide the dashboard token.
 *
 * - loopback + no `SHOAL_TOKEN` + not proxied → no token (the local-only default, unchanged UX)
 * - non-loopback, or loopback with `SHOAL_ALLOWED_HOSTS` set (`proxied`) → a
 *   token is mandatory; generated when not supplied. A reverse proxy in front
 *   of a loopback bind makes the dashboard reachable from the network just as
 *   surely as a non-loopback bind does, so it gets the same requirement.
 * - a supplied token shorter than 16 chars is refused rather than weakly accepted
 */
export function resolveDashboardToken(
  binding: Binding,
  env: NodeJS.ProcessEnv = process.env,
  proxied = false,
): TokenDecision {
  const supplied = (env.SHOAL_TOKEN ?? "").trim();
  const notices: string[] = [];

  if (supplied && supplied.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `[auth] SHOAL_TOKEN is too short (${supplied.length} chars) — use at least ${MIN_TOKEN_LENGTH}, or unset it to have one generated`,
    );
  }

  if (supplied) {
    notices.push("[auth] dashboard token: from SHOAL_TOKEN");
    return { token: supplied, generated: false, notices };
  }

  if (binding.isLoopback && !proxied) {
    notices.push(`[auth] no token required — bound to ${binding.host} (local only)`);
    return { token: null, generated: false, notices };
  }

  const token = randomBytes(24).toString("hex");
  if (proxied) {
    notices.push(
      "[auth] SHOAL_ALLOWED_HOSTS is set — a reverse proxy may expose this dashboard beyond this machine, so a token is required.",
      `[auth] generated token: ${token}`,
      `[auth] open the dashboard through your proxy with ?token=${token} appended`,
      "[auth] set SHOAL_TOKEN in .env to keep the same token across restarts.",
    );
  } else {
    notices.push(
      `[auth] bound to ${binding.host}, which is reachable from other machines — a token is required.`,
      `[auth] generated token: ${token}`,
      `[auth] open: http://${binding.host}:${binding.port}/?token=${token}`,
      "[auth] set SHOAL_TOKEN in .env to keep the same token across restarts.",
    );
  }
  return { token, generated: true, notices };
}

/** Constant-time compare that tolerates different lengths. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Name of the session cookie. The dashboard bootstraps from a `?token=` URL and
 * then rides this cookie: HttpOnly, so an XSS on the dashboard origin cannot
 * read the token out of the page and reuse it elsewhere, and automatic, so
 * EventSource and the report iframe authenticate without a token in the URL.
 */
export const SESSION_COOKIE = "shoal_session";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is not a cookie we set; skip it.
    }
  }
  return out;
}

/**
 * Token for an already-authenticated request: a header, or the session
 * cookie `issueSessionCookie` already exchanged a `?token=` for. Deliberately
 * does NOT accept `?token=` itself — that would make the bootstrap URL a
 * standing credential good against every `/api` call, not a one-time
 * exchange, and it would put the token in server access logs, browser
 * history, and any `Referer` header on every request that carried it.
 * `issueSessionCookie` (mounted ahead of this on every route, not just
 * `/api`) is the only place `?token=` is read.
 */
function presentedToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const custom = req.get("x-shoal-token");
  if (custom) return custom.trim();
  const cookie = parseCookies(req.get("cookie"))[SESSION_COOKIE];
  if (cookie) return cookie;
  return null;
}

/** True when this request reached us over TLS (directly or via a terminating proxy). */
function isSecureRequest(req: Request): boolean {
  return req.protocol === "https" || req.get("x-forwarded-proto") === "https";
}

/**
 * Turn a valid `?token=` into a session cookie, once, on whatever request
 * carries it — normally the operator opening `/?token=…`.
 *
 * This is what keeps the token out of `sessionStorage` and out of every
 * subsequent URL: the browser holds it in a cookie the page cannot read.
 */
export function issueSessionCookie(token: string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    const query = req.query?.token;
    if (typeof query === "string" && query && tokenMatches(token, query)) {
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: isSecureRequest(req),
        path: "/",
      });
    }
    next();
  };
}

/**
 * Reject requests that do not present the token. Mounted on `/api` only — the
 * static bundle stays reachable so the browser can load the UI and then send
 * the token with its own calls. A `?token=` on the request itself is not
 * accepted here — see `presentedToken` — only the cookie it was already
 * exchanged for, or a header from a scripted client.
 */
export function requireToken(token: string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    const provided = presentedToken(req);
    if (provided && tokenMatches(token, provided)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };
}

/**
 * Reject requests whose Host header is not one we are serving, and cross-origin
 * requests from a browser. Together these stop DNS rebinding and drive-by calls
 * from another site the operator happens to have open.
 *
 * `allowedHosts` (from `resolveAllowedHosts` / `SHOAL_ALLOWED_HOSTS`) extends
 * both checks with hostnames a reverse proxy is trusted to front this
 * dashboard as — see the module doc comment for why a proxy needs this.
 */
export function hostGuard(binding: Binding, allowedHosts: Set<string> = new Set()) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = req.get("host") ?? "";
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();

    const hostAllowed =
      hostname === "" ||
      isLoopbackHost(hostname) ||
      hostname === binding.host.toLowerCase() ||
      allowedHosts.has(hostname) ||
      // 0.0.0.0 means "every interface", so any Host that resolves here is ours.
      binding.host === "0.0.0.0" ||
      binding.host === "::";

    if (!hostAllowed) {
      res.status(403).json({ error: "host not allowed" });
      return;
    }

    const origin = req.get("origin");
    if (origin) {
      let originUrl: URL;
      try {
        originUrl = new URL(origin);
      } catch {
        res.status(403).json({ error: "bad origin" });
        return;
      }
      const sameOrigin = originUrl.host.toLowerCase() === hostHeader.toLowerCase();
      // On a loopback binding, another loopback port is as local as we are —
      // this is `npm run dev`, where Vite serves the UI on :5173 and proxies
      // /api to :4000. A remote attacker's page can never present one.
      const localDevOrigin = binding.isLoopback && isLoopbackHost(originUrl.hostname);
      // A proxy that rewrites Host to shoal's own upstream address (nginx's
      // default) still forwards the browser's real Origin unchanged, so Host
      // and Origin stop matching even on a legitimate same-site request.
      // Trust that Origin only when its hostname is one the operator named.
      const proxiedAllowedOrigin = allowedHosts.has(originUrl.hostname.toLowerCase());
      if (!sameOrigin && !localDevOrigin && !proxiedAllowedOrigin) {
        res.status(403).json({ error: "cross-origin request refused" });
        return;
      }
    }

    next();
  };
}
