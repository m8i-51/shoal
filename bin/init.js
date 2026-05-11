import { intro, outro, select, text, confirm, isCancel, cancel } from "@clack/prompts";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PROVIDERS = [
  { value: "anthropic",   label: "Anthropic (Claude)",  hint: "recommended",        defaultModel: "claude-haiku-4-5-20251001" },
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

  // ── GitHub (optional) ─────────────────────────────────────────────
  const githubToken = guard(await text({
    message: "GitHub token  (optional — for Issue creation)",
    placeholder: "ghp_...  leave blank to skip",
  }));
  if (githubToken.trim()) {
    env.GITHUB_TOKEN = githubToken.trim();
    const githubRepo = guard(await text({
      message: "GitHub repo",
      placeholder: "owner/repo",
    }));
    if (githubRepo.trim()) env.GITHUB_REPO = githubRepo.trim();
  }

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
