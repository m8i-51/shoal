/**
 * safe-fetch.ts — guard against SSRF before a model-chosen URL is fetched.
 *
 * `fetch_url` in product-discovery.ts lets the discovery agent pick a URL to
 * read (a README, an About page) — and, per untrusted.ts, that choice is
 * itself steered by page content the target app produced. A hostile page can
 * simply ask the agent to "read more at http://169.254.169.254/..." and the
 * agent, having no reason to doubt it, will. Without a check here that reaches
 * cloud-metadata endpoints, internal admin panels, or anything else on the
 * host's private network.
 *
 * `checkUrlSafety` decides whether a URL is safe to hand to `fetch()`
 * *before* any network call is made:
 *   1. scheme allowlist — only http/https
 *   2. destination check — for a literal IP host, the address itself; for a
 *      hostname, its resolved address (so `evil.example` pointing at
 *      127.0.0.1 in DNS is blocked too, not just literal IP URLs)
 *
 * Blocked ranges: loopback (127.0.0.0/8, ::1), link-local incl. the cloud
 * metadata address (169.254.0.0/16, fe80::/10), private IPv4 (10/8,
 * 172.16/12, 192.168/16), unique-local IPv6 (fc00::/7), and the unspecified
 * addresses (0.0.0.0/8, ::).
 *
 * Exception: shoal's own target is very often http://localhost:3000, which
 * is exactly the kind of address this guard otherwise blocks. Callers pass
 * the app's own origin explicitly as `allowedOrigin` (never read from
 * process.env here, so this stays unit-testable) and a request to that exact
 * origin is let through without the address check.
 *
 * Honest limit: resolving a hostname here and then letting the caller
 * `fetch()` it separately is a classic DNS-rebinding TOCTOU gap — nothing
 * stops the name resolving to a public address at check time and a private
 * one milliseconds later at connect time. Closing that fully would need a
 * fetch implementation that connects to the address we already resolved
 * instead of re-resolving the hostname. This guard stops the common case (a
 * page telling the agent to fetch a literal internal IP, or a hostname that
 * plainly resolves to one) without pretending to close every timing window.
 */
import { isIP } from "net";
import * as dns from "dns";

/** Minimal shape of what a DNS lookup needs to return for our purposes. */
export interface LookupResult {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<LookupResult>;

export interface SafeFetchOptions {
  /** Origin (scheme://host[:port]) that is always allowed, e.g. shoal's own BASE_URL. */
  allowedOrigin?: string;
  /** Injectable for tests; defaults to dns.promises.lookup. Never used for a literal IP host. */
  lookup?: LookupFn;
}

export type SafeFetchCheck = { ok: true } | { ok: false; reason: string };

const defaultLookup: LookupFn = (hostname) => dns.promises.lookup(hostname);

/** `new URL(...).hostname` brackets an IPv6 literal (e.g. "[::1]"); strip that for address checks. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparsable → block conservatively
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 — "this network" / unspecified
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, incl. cloud metadata (169.254.169.254)
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  return false;
}

/**
 * Expand an IPv6 literal to its 8 16-bit groups, folding a trailing embedded
 * IPv4 dotted-quad (legal only at the end, e.g. "::ffff:127.0.0.1") into two
 * hex groups first so the rest of the parser only ever sees hex.
 */
function parseIPv6Groups(raw: string): number[] | null {
  let addr = raw;
  const ipv4Tail = addr.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Tail) {
    const octets = ipv4Tail[1].split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = addr.slice(0, addr.length - ipv4Tail[1].length) + `${hi}:${lo}`;
  }

  const doubleColon = addr.indexOf("::");
  let headParts: string[];
  let tailParts: string[];
  if (doubleColon !== -1) {
    const head = addr.slice(0, doubleColon);
    const tail = addr.slice(doubleColon + 2);
    headParts = head ? head.split(":") : [];
    tailParts = tail ? tail.split(":") : [];
  } else {
    headParts = addr.split(":");
    tailParts = [];
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const filled = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (filled.length !== 8) return null;
  const groups = filled.map((g) => (g === "" ? NaN : parseInt(g, 16)));
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isBlockedIPv6(ip: string): boolean {
  const groups = parseIPv6Groups(ip);
  if (!groups) return true; // unparsable → block conservatively

  if (groups.every((g) => g === 0)) return true; // :: — unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 — loopback

  // IPv4-mapped (::ffff:a.b.c.d): defer to the IPv4 range check on the embedded address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const mapped = [(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff].join(".");
    return isBlockedIPv4(mapped);
  }

  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local

  return false;
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(address);
  return true; // not a recognizable IP at all → block conservatively
}

/**
 * Decide whether `rawUrl` is safe to fetch. Never throws — an invalid or
 * unresolvable URL comes back as `{ ok: false, reason }`, ready to hand to
 * the model in place of the fetch it asked for.
 */
export async function checkUrlSafety(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `refused to fetch "${rawUrl}": not a valid URL` };
  }

  // shoal's own target is exempt — see module comment.
  if (options.allowedOrigin && url.origin === options.allowedOrigin) {
    return { ok: true };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `refused to fetch "${rawUrl}": scheme "${url.protocol}" is not allowed (only http/https)` };
  }

  const hostname = stripBrackets(url.hostname);
  let addressToCheck = hostname;

  if (isIP(hostname) === 0) {
    // Not a literal IP — resolve it so a hostname pointed at a private
    // address is caught too. (See module comment re: DNS-rebinding TOCTOU.)
    const lookup = options.lookup ?? defaultLookup;
    try {
      const resolved = await lookup(hostname);
      addressToCheck = resolved.address;
    } catch (e) {
      return { ok: false, reason: `refused to fetch "${rawUrl}": could not resolve host "${hostname}" (${String(e)})` };
    }
  }

  if (isBlockedAddress(addressToCheck)) {
    return {
      ok: false,
      reason: `refused to fetch "${rawUrl}": it resolves to a private/internal address (${addressToCheck}) that this tool is not allowed to reach`,
    };
  }

  return { ok: true };
}
