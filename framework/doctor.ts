/**
 * doctor.ts — preflight checks, so a misconfiguration costs a second instead
 * of a run.
 *
 * shoal's failure modes are mostly environmental: a missing API key, an
 * unpriced model that makes SHOAL_MAX_USD silently unenforceable, a Chromium
 * that was never installed, a BASE_URL nothing is listening on. Every one of
 * them surfaced as a stack trace several minutes and several dollars into a
 * run. `shoal doctor` asks all of them up front.
 *
 * Every check is read-only and makes no LLM call, so running it costs nothing.
 */
import { existsSync, statSync } from "fs";
import * as path from "path";
import { estimateCostSync } from "./cost";
import { resolveBudgetLimit } from "./budget";
import {
  LOCAL_PROVIDER_IDS,
  PROVIDER_DEFAULT_MODELS,
  SUBSCRIPTION_PROVIDER_IDS,
  findProvider,
  resolveCredential,
} from "./providers";
import { resolveOutputLanguage } from "./language";
import { LOG_LEVELS } from "./log";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  /** What was found. */
  detail: string;
  /** What to do about it — only for warn/fail. */
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  /** True when nothing is broken enough to stop a run. */
  ok: boolean;
}

const MIN_NODE_MAJOR = 22;

// Both derived from the provider registry, so this file cannot fall out of
// step with the list of providers shoal actually supports.
const SUBSCRIPTION_PROVIDERS = SUBSCRIPTION_PROVIDER_IDS;
const LOCAL_PROVIDERS = LOCAL_PROVIDER_IDS;

function checkNode(version: string): Check {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (!Number.isFinite(major)) {
    return { name: "Node.js", status: "warn", detail: `unrecognised version "${version}"` };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: "Node.js",
      status: "fail",
      detail: `${version} — shoal requires >= ${MIN_NODE_MAJOR}`,
      fix: `install Node ${MIN_NODE_MAJOR}+ (the repo ships an .nvmrc: nvm use)`,
    };
  }
  return { name: "Node.js", status: "ok", detail: version };
}

function checkEnvFile(cwd: string, env: NodeJS.ProcessEnv): Check {
  const envPath = env.SHOAL_ENV_FILE ?? path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return {
      name: ".env",
      status: "warn",
      detail: `not found at ${envPath} — shoal will fall back to the process environment`,
      fix: "run `shoal init` in this directory",
    };
  }
  // A file holding API keys should not be world- or group-readable. Windows
  // does not model POSIX bits, so only flag it where the check means something.
  if (process.platform !== "win32") {
    const mode = statSync(envPath).mode & 0o077;
    if (mode !== 0) {
      return {
        name: ".env",
        status: "warn",
        detail: `${envPath} is readable by other users (mode ${(statSync(envPath).mode & 0o777).toString(8)})`,
        fix: `chmod 600 ${envPath}`,
      };
    }
  }
  return { name: ".env", status: "ok", detail: envPath };
}

function credentialFor(provider: string, env: NodeJS.ProcessEnv): Check {
  const name = "LLM credentials";
  if (SUBSCRIPTION_PROVIDERS.has(provider)) {
    const detail =
      provider === "claude-cli"
        ? "claude-cli uses your Claude Code login (npm run auth:claude)"
        : "codex uses your ChatGPT login (npm run auth:codex)";
    // Both bill the subscription; a stray ANTHROPIC_API_KEY silently moves
    // claude-cli onto metered API billing instead.
    if (provider === "claude-cli" && env.ANTHROPIC_API_KEY) {
      return {
        name,
        status: "warn",
        detail: "ANTHROPIC_API_KEY is set alongside LLM_PROVIDER=claude-cli",
        fix: "unset ANTHROPIC_API_KEY to bill your Pro/Max subscription rather than the API",
      };
    }
    return { name, status: "ok", detail };
  }
  if (LOCAL_PROVIDERS.has(provider)) {
    return { name, status: "ok", detail: `${provider} runs locally — no credential needed` };
  }
  if (provider === "bedrock") {
    const explicit = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
    return {
      name,
      status: "ok",
      detail: explicit
        ? "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY set"
        : "no AWS_* keys set — falling back to the default AWS credential chain",
    };
  }
  // Everything else names the env vars that can carry its credential in the
  // registry, so this stays correct as providers are added.
  const spec = findProvider(provider);
  const names = spec?.credentialEnv ?? ["LLM_API_KEY", "OPENAI_API_KEY"];
  if (spec && resolveCredential(spec, env)) {
    return { name, status: "ok", detail: `${names.find((n) => env[n])} set` };
  }
  if (!spec && (env.LLM_API_KEY || env.OPENAI_API_KEY)) {
    return { name, status: "ok", detail: "LLM_API_KEY set" };
  }
  return {
    name,
    status: "fail",
    detail: `${names[0]} is not set for provider "${provider}"`,
    fix: `add ${names[0]} to .env`,
  };
}

function checkSpendCap(provider: string, model: string, env: NodeJS.ProcessEnv): Check {
  const name = "Spend cap";
  const limit = resolveBudgetLimit(env);
  if (limit == null) {
    return {
      name,
      status: "warn",
      detail: "SHOAL_MAX_USD is not set — this run has no cost ceiling",
      fix: "set SHOAL_MAX_USD to cap what one run can spend",
    };
  }
  // The cap counts unpriced models as zero, so an unpriced model means the cap
  // is configured but can never fire. That is exactly the case an operator
  // believes they are covered and is not.
  const priced = estimateCostSync(model, provider, 1, 1) != null;
  if (!priced) {
    const openrouter = provider === "openrouter" ? " (OpenRouter prices are fetched at run start)" : "";
    return {
      name,
      status: "warn",
      detail: `SHOAL_MAX_USD=$${limit} is set, but no price is known for "${model}" on "${provider}"${openrouter} — the cap cannot fire`,
      fix: "use a model with published pricing, or treat the run as uncapped",
    };
  }
  return { name, status: "ok", detail: `$${limit} cap, and "${model}" is priced so it can fire` };
}

function checkBrowser(env: NodeJS.ProcessEnv): Check {
  const name = "Playwright browser";
  const explicit = env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit && existsSync(explicit)) {
    return { name, status: "ok", detail: `PLAYWRIGHT_BROWSERS_PATH=${explicit}` };
  }
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const candidates = [
    path.join(home, ".cache", "ms-playwright"),
    path.join(home, "Library", "Caches", "ms-playwright"),
    path.join(home, "AppData", "Local", "ms-playwright"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found) return { name, status: "ok", detail: found };
  return {
    name,
    status: "fail",
    detail: "no Playwright browser cache found — agents cannot open a page",
    fix: "npx playwright install chromium",
  };
}

function checkTarget(env: NodeJS.ProcessEnv): Check {
  const name = "Target app";
  const baseUrl = env.BASE_URL;
  if (!baseUrl) {
    return { name, status: "fail", detail: "BASE_URL is not set", fix: "set BASE_URL to the app you want explored" };
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { name, status: "fail", detail: `BASE_URL is "${baseUrl}" — expected http(s)`, fix: "use an http:// or https:// URL" };
    }
    return { name, status: "ok", detail: `${baseUrl} (TARGET=${env.TARGET ?? "none"})` };
  } catch {
    return { name, status: "fail", detail: `BASE_URL is not a valid URL: "${baseUrl}"`, fix: "set BASE_URL to a full http(s) URL" };
  }
}

function checkTracker(env: NodeJS.ProcessEnv): Check {
  const name = "Issue tracker";
  const configured = (env.ISSUE_TRACKERS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const githubImplied = configured.length === 0 && Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO);
  const enabled = githubImplied ? ["github"] : configured;
  if (enabled.length === 0) {
    // Not a failure: report-only runs are a supported way to use shoal.
    return { name, status: "warn", detail: "none configured — findings are reported but never filed", fix: "set ISSUE_TRACKERS (or GITHUB_TOKEN + GITHUB_REPO) to file issues" };
  }
  const missing: string[] = [];
  if (enabled.includes("github") && !(env.GITHUB_TOKEN && env.GITHUB_REPO)) missing.push("github (GITHUB_TOKEN, GITHUB_REPO)");
  if (enabled.includes("jira") && !(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN && env.JIRA_PROJECT_KEY)) missing.push("jira (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY)");
  if (enabled.includes("notion") && !(env.NOTION_API_KEY && env.NOTION_DATABASE_ID)) missing.push("notion (NOTION_API_KEY, NOTION_DATABASE_ID)");
  if (enabled.includes("backlog")) {
    const projectId = parseInt(env.BACKLOG_PROJECT_ID ?? "", 10);
    if (!(env.BACKLOG_SPACE && env.BACKLOG_API_KEY && !Number.isNaN(projectId))) {
      missing.push("backlog (BACKLOG_SPACE, BACKLOG_API_KEY, BACKLOG_PROJECT_ID numeric)");
    }
  }
  if (enabled.includes("asana") && !(env.ASANA_ACCESS_TOKEN && env.ASANA_PROJECT_ID)) missing.push("asana (ASANA_ACCESS_TOKEN, ASANA_PROJECT_ID)");
  if (missing.length > 0) {
    return { name, status: "fail", detail: `enabled but incompletely configured: ${missing.join("; ")}`, fix: "fill in the listed variables, or remove the tracker from ISSUE_TRACKERS" };
  }
  return { name, status: "ok", detail: enabled.join(", ") + (githubImplied ? " (implied by GITHUB_TOKEN/GITHUB_REPO)" : "") };
}

function checkDashboardBuild(packageRoot: string): Check {
  const name = "Dashboard build";
  if (existsSync(path.join(packageRoot, "web", "dist", "index.html"))) {
    return { name, status: "ok", detail: "web/dist is built" };
  }
  return {
    name,
    status: "warn",
    detail: "web/dist not built — `shoal serve` will build it on first start",
    fix: "npm run build:web to build it now",
  };
}

function checkSettings(env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = [];
  const level = (env.SHOAL_LOG_LEVEL ?? "").trim().toLowerCase();
  if (level && !(LOG_LEVELS as readonly string[]).includes(level)) {
    checks.push({
      name: "SHOAL_LOG_LEVEL",
      status: "warn",
      detail: `"${env.SHOAL_LOG_LEVEL}" is not a level — falling back to info`,
      fix: `use one of ${LOG_LEVELS.join(", ")}`,
    });
  }
  const language = resolveOutputLanguage(env);
  if (language) checks.push({ name: "Output language", status: "ok", detail: language });
  return checks;
}

/**
 * Run every check. Pure apart from filesystem reads, so it is fully testable
 * and costs nothing to run.
 */
export function runDoctor(opts: {
  cwd: string;
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
} ): DoctorReport {
  const env = opts.env ?? process.env;
  const provider = env.LLM_PROVIDER ?? "anthropic";
  const model = env.LLM_MODEL ?? PROVIDER_DEFAULT_MODELS[provider] ?? "";

  const checks: Check[] = [
    checkNode(opts.nodeVersion ?? process.version),
    checkEnvFile(opts.cwd, env),
    { name: "LLM provider", status: "ok", detail: `${provider}, model ${model || "(unset — provider default)"}` },
    credentialFor(provider, env),
    checkSpendCap(provider, model, env),
    checkBrowser(env),
    checkTarget(env),
    checkTracker(env),
    checkDashboardBuild(opts.packageRoot),
    ...checkSettings(env),
  ];

  return { checks, ok: !checks.some((c) => c.status === "fail") };
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Render a report for the terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = ["shoal doctor", ""];
  for (const check of report.checks) {
    lines.push(`  ${ICON[check.status]} ${check.name.padEnd(width)}  ${check.detail}`);
    // width + 4 puts the arrow under the detail column: 2 indent + icon + space.
    if (check.fix) lines.push(`  ${" ".repeat(width + 4)}→ ${check.fix}`);
  }
  const failures = report.checks.filter((c) => c.status === "fail").length;
  const warnings = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    failures > 0
      ? `${failures} problem${failures === 1 ? "" : "s"} will stop a run${warnings > 0 ? `, ${warnings} worth a look` : ""}.`
      : warnings > 0
        ? `Nothing blocking; ${warnings} worth a look.`
        : "All checks passed.",
  );
  return lines.join("\n");
}
