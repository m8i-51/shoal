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
 * - loopback + no `SHOAL_TOKEN` → no token (the local-only default, unchanged UX)
 * - non-loopback → a token is mandatory; generated when not supplied
 * - a supplied token shorter than 16 chars is refused rather than weakly accepted
 */
export function resolveDashboardToken(
  binding: Binding,
  env: NodeJS.ProcessEnv = process.env,
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

  if (binding.isLoopback) {
    notices.push(`[auth] no token required — bound to ${binding.host} (local only)`);
    return { token: null, generated: false, notices };
  }

  const token = randomBytes(24).toString("hex");
  notices.push(
    `[auth] bound to ${binding.host}, which is reachable from other machines — a token is required.`,
    `[auth] generated token: ${token}`,
    `[auth] open: http://${binding.host}:${binding.port}/?token=${token}`,
    "[auth] set SHOAL_TOKEN in .env to keep the same token across restarts.",
  );
  return { token, generated: true, notices };
}

/** Constant-time compare that tolerates different lengths. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const custom = req.get("x-shoal-token");
  if (custom) return custom.trim();
  // EventSource cannot set headers, and report links open in a new tab.
  const query = req.query?.token;
  if (typeof query === "string" && query) return query;
  return null;
}

/**
 * Reject requests that do not present the token. Mounted on `/api` only — the
 * static bundle stays reachable so the browser can load the UI and then send
 * the token with its own calls.
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
 */
export function hostGuard(binding: Binding) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = req.get("host") ?? "";
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();

    const hostAllowed =
      hostname === "" ||
      isLoopbackHost(hostname) ||
      hostname === binding.host.toLowerCase() ||
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
      if (!sameOrigin && !localDevOrigin) {
        res.status(403).json({ error: "cross-origin request refused" });
        return;
      }
    }

    next();
  };
}
