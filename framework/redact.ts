/**
 * Mask secrets in tool logs and persisted run artifacts.
 * Password field values must never appear in console, run JSON, or HTML reports.
 */

export const REDACTED_SECRET = "********";

const PASSWORD_LABEL_RE =
  /password|passwd|passcode|pass phrase|secret|暗証|パスワード|パスワー/i;

export function isPasswordLabel(label: string | null | undefined): boolean {
  return Boolean(label && PASSWORD_LABEL_RE.test(String(label)));
}

export function redactToolInput(
  tool: string,
  input: Record<string, unknown> | null | undefined,
  opts?: { passwordField?: boolean },
): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const next: Record<string, unknown> = { ...input };

  if (typeof next.password === "string") {
    next.password = REDACTED_SECRET;
  }

  if (tool === "fill") {
    const label = typeof next.label === "string" ? next.label : "";
    if (opts?.passwordField || isPasswordLabel(label)) {
      if ("value" in next) next.value = REDACTED_SECRET;
    }
  }

  return next;
}

export function redactUnknown(tool: string, value: unknown, opts?: { passwordField?: boolean }): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactToolInput(tool, value as Record<string, unknown>, opts);
  }
  return value;
}

export function redactFillResultText(
  label: string,
  value: string,
  passwordField?: boolean,
): string {
  const shown = passwordField || isPasswordLabel(label) ? REDACTED_SECRET : value;
  return `Filled "${label}" with "${shown}"`;
}

export function formatToolCallLog(
  tool: string,
  input: Record<string, unknown>,
  maxLen = 80,
  opts?: { passwordField?: boolean },
): string {
  const redacted = redactToolInput(tool, input, opts);
  return `${tool}(${JSON.stringify(redacted).slice(0, maxLen)})`;
}

type ActionLike = {
  tool: string;
  input?: unknown;
  result?: unknown;
};

type AgentLogLike = {
  actions?: ActionLike[];
};

export function redactRunLog<T extends { agents?: AgentLogLike[] }>(log: T): T {
  if (!Array.isArray(log.agents)) return log;
  return {
    ...log,
    agents: log.agents.map((agent) => ({
      ...agent,
      actions: (agent.actions ?? []).map((act) => ({
        ...act,
        input: redactUnknown(act.tool, act.input),
        result: redactUnknown(act.tool, act.result),
      })),
    })),
  };
}
