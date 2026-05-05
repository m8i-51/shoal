import { intro, outro, select, text, isCancel, cancel } from "@clack/prompts";
import { writeFileSync, existsSync } from "fs";
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

  outro("Created .env\n\n  shoal serve   — open the dashboard at http://localhost:4000\n  shoal         — run agents from the terminal");
}
