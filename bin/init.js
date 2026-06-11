import { intro, outro, select, multiselect, text, confirm, isCancel, cancel } from "@clack/prompts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PROVIDERS = [
  { value: "anthropic",   label: "Anthropic (Claude)",  hint: "recommended",        defaultModel: "claude-haiku-4-5-20251001" },
  { value: "bedrock",     label: "Amazon Bedrock",      hint: "AWS credentials",    defaultModel: "anthropic.claude-3-5-haiku-20241022-v1:0" },
  { value: "openai",      label: "OpenAI",                                           defaultModel: "gpt-4o-mini" },
  { value: "groq",        label: "Groq",                hint: "free tier available", defaultModel: "llama-3.3-70b-versatile" },
  { value: "gemini",      label: "Gemini",              hint: "free tier available", defaultModel: "gemini-2.0-flash" },
  { value: "ollama",      label: "Ollama",              hint: "local",               defaultModel: null },
  { value: "lm-studio",   label: "LM Studio",          hint: "local",               defaultModel: null },
  { value: "openrouter",  label: "OpenRouter",                                       defaultModel: "google/gemini-flash-1.5" },
];

function guard(value) {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}

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
    env.AWS_ACCESS_KEY_ID = guard(await text({
      message: "AWS_ACCESS_KEY_ID",
      placeholder: "AKIA...",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.AWS_SECRET_ACCESS_KEY = guard(await text({
      message: "AWS_SECRET_ACCESS_KEY",
      placeholder: "...",
      validate: (v) => v?.trim() ? undefined : "Required",
    }));
    env.AWS_REGION = guard(await text({
      message: "AWS region",
      defaultValue: "us-east-1",
    }));
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

  // ── Issue trackers (optional) ─────────────────────────────────────
  const trackerEnv = await promptTrackers();
  Object.assign(env, trackerEnv);

  // ── Write .env ────────────────────────────────────────────────────
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

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
    writeFileSync(workflowPath, `# shoal weekly run
#
# Required secrets:  ANTHROPIC_API_KEY
# Required variables: STAGING_URL is hardcoded below — update as needed
#
# GitHub Issues are filed automatically using the built-in GITHUB_TOKEN.

name: shoal weekly run

on:
  schedule:
    - cron: '0 9 * * 1'   # every Monday at 09:00 UTC
  workflow_dispatch:        # also allow manual trigger from the Actions tab

jobs:
  shoal:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install shoal
        run: npm install -g @m8i-51/shoal

      - name: Install Playwright browsers
        run: npx playwright install chromium --with-deps

      - name: Run shoal
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          BASE_URL: ${stagingUrl.trim()}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPO: \${{ github.repository }}
          MAX_BROWSERS: '2'
          MAX_EXPLORERS: '0'
        run: shoal
`, "utf-8");

    console.log(`\n  Created ${workflowPath}`);
    console.log("  Next: add ANTHROPIC_API_KEY to your repo's Actions secrets");
  }

  outro("Created .env\n\n  shoal serve   — open the dashboard at http://localhost:4000\n  shoal         — run agents from the terminal");
}

// ── Tracker config helpers ─────────────────────────────────────────

const TRACKER_KEYS = [
  "ISSUE_TRACKERS",
  "GITHUB_TOKEN", "GITHUB_REPO",
  "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY",
  "NOTION_API_KEY", "NOTION_DATABASE_ID",
  "BACKLOG_SPACE", "BACKLOG_API_KEY", "BACKLOG_PROJECT_ID",
  "ASANA_ACCESS_TOKEN", "ASANA_PROJECT_ID",
];

function parseEnv(content) {
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

function updateEnvFile(envPath, newKeys, removeKeys) {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = content.split("\n").filter((line) => {
    const key = line.split("=")[0].trim();
    return !removeKeys.includes(key);
  });
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const newLines = Object.entries(newKeys).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, [...lines, "", ...newLines, ""].join("\n"), "utf-8");
}

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
