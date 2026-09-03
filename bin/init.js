import { intro, outro, select, multiselect, text, confirm, isCancel, cancel } from "@clack/prompts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

// Kept in sync with framework/llm-client.ts's PROVIDER_DEFAULT_MODELS by
// framework/__tests__/provider-defaults.test.ts — this file is plain JS run
// directly by node (no tsx), so it cannot import that .ts module at runtime
// and instead carries its own copy of the same default model ids.
export const PROVIDERS = [
  { value: "anthropic",   label: "Anthropic (Claude)",  hint: "recommended",        defaultModel: "claude-haiku-4-5-20251001" },
  { value: "bedrock",     label: "Amazon Bedrock",      hint: "AWS credentials",    defaultModel: "anthropic.claude-haiku-4-5-20251001-v1:0" },
  { value: "openai",      label: "OpenAI",                                           defaultModel: "gpt-4o-mini" },
  { value: "groq",        label: "Groq",                hint: "free tier available", defaultModel: "llama-3.3-70b-versatile" },
  { value: "gemini",      label: "Gemini",              hint: "free tier available", defaultModel: "gemini-2.0-flash" },
  { value: "ollama",      label: "Ollama",              hint: "local",               defaultModel: null },
  { value: "lm-studio",   label: "LM Studio",          hint: "local",               defaultModel: null },
  { value: "openrouter",  label: "OpenRouter",                                       defaultModel: "google/gemini-2.0-flash-001" },
];

/* v8 ignore start -- thin wrapper around @clack/prompts cancellation; not meaningfully unit-testable without mocking the whole prompt library */
function guard(value) {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}
/* v8 ignore stop */

/**
 * Generate .github/workflows/shoal-weekly.yml by substituting into the
 * packaged shoal-weekly.example.yml, instead of keeping a second hand-written
 * copy of the workflow. Two copies drifted before: this one still had
 * actions/checkout@v4, setup-node@v4, and Node 20 after the example (and
 * shoal's own CI) moved to v7 / Node 22.
 *
 * The example file is designed to be copied verbatim and stays inert until a
 * STAGING_URL repository variable is set; here the user already typed the URL
 * into the prompt, so it is baked in directly and the `if:` guard is removed.
 */
export function renderWeeklyWorkflow(stagingUrl) {
  const templatePath = join(packageRoot, ".github", "workflows", "shoal-weekly.example.yml");
  const content = readFileSync(templatePath, "utf-8");

  const conditionalBlock =
    "    # Only runs once STAGING_URL is configured as a repository variable.\n" +
    "    # This keeps the file inert in the upstream shoal repo (where it isn't set)\n" +
    "    # and self-activating in your repo as soon as you add the variable.\n" +
    "    if: ${{ vars.STAGING_URL != '' }}\n";
  const baseUrlLine = "BASE_URL: ${{ vars.STAGING_URL }}";
  const requiredVarsLine = "# Required variables: STAGING_URL (e.g. https://staging.example.com)\n";

  if (!content.includes(conditionalBlock) || !content.includes(baseUrlLine) || !content.includes(requiredVarsLine)) {
    throw new Error(
      "shoal-weekly.example.yml no longer matches what bin/init.js expects to substitute — " +
        "update renderWeeklyWorkflow() in bin/init.js to match its current shape",
    );
  }

  return content
    .replace(conditionalBlock, "")
    .replace(baseUrlLine, `BASE_URL: ${JSON.stringify(stagingUrl)}`)
    .replace(requiredVarsLine, "");
}

/* v8 ignore start -- interactive @clack/prompts wizard; exercised manually (`shoal init`), not by unit tests */
export async function runInit(cwd) {
  const envPath = join(cwd, ".env");

  if (existsSync(envPath)) {
    console.log(".env already exists. Delete it and run shoal init again.");
    process.exit(0);
  }

  intro("shoal init");

  // ── Provider ──────────────────────────────────────────────────────
  const provider = guard(await select({
    message: "LLM provider",
    options: PROVIDERS,
  }));

  const env = {};

  const providerDef = PROVIDERS.find((p) => p.value === provider);

  // ── Provider-specific questions ───────────────────────────────────
  if (provider === "anthropic") {
    env.ANTHROPIC_API_KEY = guard(await text({
      message: "ANTHROPIC_API_KEY",
      placeholder: "sk-ant-...",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
  } else if (provider === "bedrock") {
    env.LLM_PROVIDER = "bedrock";
    const accessKey = guard(await text({
      message: "AWS_ACCESS_KEY_ID (leave blank to use existing profile keys / default credential chain)",
      placeholder: "AKIA... or blank",
    }));
    if (accessKey.trim()) env.AWS_ACCESS_KEY_ID = accessKey.trim();
    const secretKey = guard(await text({
      message: "AWS_SECRET_ACCESS_KEY (leave blank to use the default credential chain)",
      placeholder: "leave blank if using a profile / SSO / instance role",
    }));
    if (secretKey.trim()) env.AWS_SECRET_ACCESS_KEY = secretKey.trim();
    const region = guard(await text({
      message: "AWS region (leave blank to use the profile / default region)",
      placeholder: "ap-northeast-1",
    }));
    if (region.trim()) env.AWS_REGION = region.trim();
  } else if (provider === "ollama") {
    env.LLM_PROVIDER = "ollama";
    const baseUrl = guard(await text({
      message: "Ollama base URL",
      defaultValue: "http://localhost:11434/v1",
    }));
    if (baseUrl !== "http://localhost:11434/v1") env.LLM_BASE_URL = baseUrl;
  } else if (provider === "lm-studio") {
    env.LLM_PROVIDER = "lm-studio";
    const baseUrl = guard(await text({
      message: "LM Studio base URL",
      defaultValue: "http://localhost:1234/v1",
    }));
    if (baseUrl !== "http://localhost:1234/v1") env.LLM_BASE_URL = baseUrl;
  } else {
    env.LLM_PROVIDER = provider;
    env.LLM_API_KEY = guard(await text({
      message: "API key",
      placeholder: "sk-...",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
  }

  const defaultModel = providerDef?.defaultModel;
  const model = guard(await text({
    message: "Model name",
    placeholder: defaultModel ? `leave blank to use ${defaultModel}` : "required",
    validate: !defaultModel ? (v) => v?.trim() ? undefined : "Required" : undefined,
  }));
  if (model.trim()) env.LLM_MODEL = model.trim();

  // ── Target app ────────────────────────────────────────────────────
  env.BASE_URL = guard(await text({
    message: "URL of the app to test",
    defaultValue: "http://localhost:3000",
  }));

  // ── Spend cap (optional) ──────────────────────────────────────────
  // Turn budgets bound how long each agent explores; this bounds the run.
  const maxUsd = guard(await text({
    message: "Spend cap per run in USD (leave blank for no cap)",
    placeholder: "e.g. 5",
    validate: (v) => {
      if (!v?.trim()) return undefined;
      const parsed = Number(v.trim());
      return Number.isFinite(parsed) && parsed > 0 ? undefined : "Enter a positive number, or leave blank";
    },
  }));
  if (maxUsd.trim()) env.SHOAL_MAX_USD = maxUsd.trim();

  // ── Issue trackers (optional) ─────────────────────────────────────
  const trackerEnv = await promptTrackers();
  Object.assign(env, trackerEnv);

  // ── Write .env ────────────────────────────────────────────────────
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  // This file holds API keys and tracker tokens in plain text — the default
  // 0o644 would leave it world-readable on a shared machine. chmod, not just
  // writeFileSync's `mode` option: that option only takes effect when the
  // write creates the file, and is silently ignored on an existing one.
  chmodSync(envPath, 0o600);

  // ── GitHub Actions workflow (optional) ────────────────────────────
  const wantsWorkflow = guard(await confirm({
    message: "Generate a GitHub Actions workflow for weekly scheduled runs?",
    initialValue: false,
  }));

  if (wantsWorkflow) {
    const stagingUrl = guard(await text({
      message: "Staging URL (used as BASE_URL in the workflow)",
      placeholder: "https://staging.example.com",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));

    const workflowDir = join(cwd, ".github", "workflows");
    const workflowPath = join(workflowDir, "shoal-weekly.yml");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(workflowPath, renderWeeklyWorkflow(stagingUrl.trim()), "utf-8");

    console.log(`\n  Created ${workflowPath}`);
    console.log("  Next: add ANTHROPIC_API_KEY to your repo's Actions secrets");
  }

  outro("Created .env\n\n  shoal serve   — open the dashboard at http://localhost:4000\n  shoal         — run agents from the terminal");
}

/* v8 ignore stop */

// ── Tracker config helpers ─────────────────────────────────────────

const TRACKER_KEYS = [
  "ISSUE_TRACKERS",
  "GITHUB_TOKEN", "GITHUB_REPO",
  "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY",
  "NOTION_API_KEY", "NOTION_DATABASE_ID",
  "BACKLOG_SPACE", "BACKLOG_API_KEY", "BACKLOG_PROJECT_ID",
  "ASANA_ACCESS_TOKEN", "ASANA_PROJECT_ID",
];

export function parseEnv(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return result;
}

export function updateEnvFile(envPath, newKeys, removeKeys) {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = content.split("\n").filter((line) => {
    const key = line.split("=")[0].trim();
    return !removeKeys.includes(key);
  });
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const newLines = Object.entries(newKeys).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, [...lines, "", ...newLines, ""].join("\n"), "utf-8");
  // Same reasoning as runInit's own writeFileSync above — and this path
  // always rewrites an existing .env, exactly the case where a mode passed
  // to writeFileSync itself would be silently ignored.
  chmodSync(envPath, 0o600);
}

/* v8 ignore start -- interactive @clack/prompts wizard; exercised manually (`shoal init` / `shoal config`), not by unit tests */
async function promptTrackers(existing = {}) {
  const currentTrackers = (existing.ISSUE_TRACKERS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const selectedTrackers = guard(await multiselect({
    message: "Issue trackers  (select all that apply; leave empty to save locally only)",
    options: [
      { value: "github",  label: "GitHub Issues", selected: currentTrackers.includes("github") },
      { value: "jira",    label: "Jira",           selected: currentTrackers.includes("jira") },
      { value: "notion",  label: "Notion",          selected: currentTrackers.includes("notion") },
      { value: "backlog", label: "Backlog",         selected: currentTrackers.includes("backlog") },
      { value: "asana",   label: "Asana",           selected: currentTrackers.includes("asana") },
    ],
    required: false,
  }));

  const env = {};

  if (selectedTrackers.length > 0) {
    env.ISSUE_TRACKERS = selectedTrackers.join(",");
  }

  if (selectedTrackers.includes("github")) {
    env.GITHUB_TOKEN = guard(await text({
      message: "GitHub token",
      placeholder: "ghp_...",
      initialValue: existing.GITHUB_TOKEN ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.GITHUB_REPO = guard(await text({
      message: "GitHub repo",
      placeholder: "owner/repo",
      initialValue: existing.GITHUB_REPO ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
  }

  if (selectedTrackers.includes("jira")) {
    env.JIRA_BASE_URL = guard(await text({
      message: "Jira base URL",
      placeholder: "https://yourcompany.atlassian.net",
      initialValue: existing.JIRA_BASE_URL ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.JIRA_EMAIL = guard(await text({
      message: "Jira account email",
      initialValue: existing.JIRA_EMAIL ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.JIRA_API_TOKEN = guard(await text({
      message: "Jira API token",
      initialValue: existing.JIRA_API_TOKEN ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.JIRA_PROJECT_KEY = guard(await text({
      message: "Jira project key",
      placeholder: "PROJ",
      initialValue: existing.JIRA_PROJECT_KEY ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
  }

  if (selectedTrackers.includes("notion")) {
    env.NOTION_API_KEY = guard(await text({
      message: "Notion API key",
      placeholder: "secret_...",
      initialValue: existing.NOTION_API_KEY ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.NOTION_DATABASE_ID = guard(await text({
      message: "Notion database ID",
      hint: "DB must have Name (title), Labels (multi_select), Status (select) properties",
      initialValue: existing.NOTION_DATABASE_ID ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
  }

  if (selectedTrackers.includes("backlog")) {
    env.BACKLOG_SPACE = guard(await text({
      message: "Backlog space name",
      placeholder: "yourspace  (from yourspace.backlog.com)",
      initialValue: existing.BACKLOG_SPACE ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.BACKLOG_API_KEY = guard(await text({
      message: "Backlog API key",
      initialValue: existing.BACKLOG_API_KEY ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.BACKLOG_PROJECT_ID = guard(await text({
      message: "Backlog project ID  (numeric)",
      initialValue: existing.BACKLOG_PROJECT_ID ?? "",
      validate: (v) => /^\d+$/.test(v?.trim()) ? undefined : "Must be a number",
    }));
  }

  if (selectedTrackers.includes("asana")) {
    env.ASANA_ACCESS_TOKEN = guard(await text({
      message: "Asana personal access token",
      initialValue: existing.ASANA_ACCESS_TOKEN ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.ASANA_PROJECT_ID = guard(await text({
      message: "Asana project ID",
      initialValue: existing.ASANA_PROJECT_ID ?? "",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
  }

  return env;
}

export async function runConfig(cwd) {
  const envPath = join(cwd, ".env");

  if (!existsSync(envPath)) {
    console.log(".env not found. Run shoal init first.");
    process.exit(1);
  }

  intro("shoal config");

  const section = guard(await select({
    message: "What do you want to configure?",
    options: [
      { value: "trackers", label: "Issue trackers" },
    ],
  }));

  if (section === "trackers") {
    const existing = parseEnv(readFileSync(envPath, "utf-8"));
    const newTrackerEnv = await promptTrackers(existing);
    updateEnvFile(envPath, newTrackerEnv, TRACKER_KEYS);
    outro("Updated .env — run shoal to apply changes");
  }
}
