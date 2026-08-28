/** Issue identifier as returned by trackers (GitHub: number, Backlog/Jira: "PROJ-55"). */
export type IssueIdentifier = number | string;

interface IssueRef {
  number: IssueIdentifier;
  title?: string;
}

/**
 * Resolve a raw issue identifier from an agent tool call to the tracker's canonical form.
 * Handles Backlog/Jira keys (e.g. "PROJ-55") and bare numeric suffixes (e.g. "55" → "PROJ-55").
 */
export function resolveIssueId(raw: unknown, knownIssues: IssueRef[] = []): IssueIdentifier {
  const s = String(raw).trim();
  if (!s) return s;

  // Already a project-prefixed key (Backlog, Jira, etc.)
  if (/^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(s)) return s;

  // Exact match against known issues
  const exact = knownIssues.find((i) => String(i.number) === s);
  if (exact) return exact.number;

  // Bare numeric suffix: "55" → "PROJ-55"
  if (/^\d+$/.test(s)) {
    const suffix = knownIssues.find((i) => {
      const key = String(i.number);
      return key.endsWith(`-${s}`) || key === s;
    });
    if (suffix) return suffix.number;
  }

  // Fallback: return as-is (GitHub numeric strings still work via commentOnIssue)
  return /^\d+$/.test(s) ? Number(s) : s;
}
