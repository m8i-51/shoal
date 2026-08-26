/**
 * Reconstruct a fetch URL whose host comes only from a server-controlled
 * allowlist. CodeQL treats user-supplied URLs as SSRF taint; copying path/search
 * onto a literal origin, then requiring that prefix, removes the host from the
 * attacker-controlled surface.
 */
const ALLOWED_PROXY_HOSTS = ["raw.githubusercontent.com", "gist.githubusercontent.com"] as const;

export type AllowedProxyHost = (typeof ALLOWED_PROXY_HOSTS)[number];

function isAllowedProxyHost(hostname: string): hostname is AllowedProxyHost {
  return (ALLOWED_PROXY_HOSTS as readonly string[]).includes(hostname);
}

function originForAllowedHost(hostname: AllowedProxyHost): string {
  switch (hostname) {
    case "raw.githubusercontent.com":
      return "https://raw.githubusercontent.com";
    case "gist.githubusercontent.com":
      return "https://gist.githubusercontent.com";
    default: {
      const _exhaustive: never = hostname;
      return _exhaustive;
    }
  }
}

/** Returns a safe https URL string, or null if the input must not be fetched. */
export function buildSafeProxyUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.port !== "") return null;
  if (!isAllowedProxyHost(parsed.hostname)) return null;

  const origin = originForAllowedHost(parsed.hostname);
  const safe = new URL(origin);
  safe.pathname = parsed.pathname;
  safe.search = parsed.search;
  const href = safe.toString();
  if (!href.startsWith(`${origin}/`)) return null;
  return href;
}
