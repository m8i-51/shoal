import type { Credentials, TargetConfig } from "./types";
import { exampleConfig } from "./example";
import { noopTarget } from "./noop";

const TARGETS: Record<string, TargetConfig> = {
  "example": exampleConfig,
  "none": noopTarget,
};

export function loadTarget(name: string): TargetConfig {
  const target = TARGETS[name];
  if (!target) {
    console.warn(`[target] "${name}" not found, falling back to noop`);
    return noopTarget;
  }
  return target;
}

export interface ConfigLoadMessage {
  level: "log" | "warn";
  text: string;
}

/**
 * Merge a workspace `shoal.config.*` export onto the current target.
 *
 * A full target (appTools + execute) replaces the current config.
 * Credentials / projectPath are still applied when tools are missing, so login
 * setup does not depend on API explorer tool definitions.
 */
export function applyLoadedTarget(
  current: TargetConfig,
  exported: unknown,
  fileName: string,
): { config: TargetConfig; messages: ConfigLoadMessage[] } {
  const mod = asConfigModule(exported);
  const t = mod?.target ?? mod?.default?.target;
  if (!t || typeof t !== "object") {
    return {
      config: current,
      messages: [{ level: "warn", text: `[config] ${fileName} found but does not export a valid target` }],
    };
  }

  const hasTools = Array.isArray(t.appTools) && typeof t.execute === "function";
  if (hasTools) {
    return {
      config: t as TargetConfig,
      messages: [{ level: "log", text: `[config] loaded: ${fileName}` }],
    };
  }

  const credentials = usableCredentials(t.credentials);
  const projectPath = typeof t.projectPath === "string" && t.projectPath.length > 0
    ? t.projectPath
    : undefined;

  if (!credentials && !projectPath) {
    return {
      config: current,
      messages: [{
        level: "warn",
        text: `[config] ${fileName} found but does not export a valid target (need appTools and execute, or credentials / projectPath)`,
      }],
    };
  }

  const applied: string[] = [];
  if (credentials) applied.push("credentials");
  if (projectPath) applied.push("projectPath");

  return {
    config: {
      ...current,
      ...(credentials ? { credentials } : {}),
      ...(projectPath ? { projectPath } : {}),
    },
    messages: [{
      level: "warn",
      text: `[config] ${fileName} has no appTools/execute — API explorers disabled; applied ${applied.join(" and ")}`,
    }],
  };
}

function asConfigModule(exported: unknown): {
  target?: Partial<TargetConfig>;
  default?: { target?: Partial<TargetConfig> };
} | null {
  if (!exported || typeof exported !== "object") return null;
  return exported as { target?: Partial<TargetConfig>; default?: { target?: Partial<TargetConfig> } };
}

function usableCredentials(value: unknown): Credentials | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as { email?: unknown; password?: unknown };
  if (typeof rec.email !== "string" || rec.email.trim() === "") return undefined;
  if (typeof rec.password !== "string" || rec.password === "") return undefined;
  return { email: rec.email, password: rec.password };
}
