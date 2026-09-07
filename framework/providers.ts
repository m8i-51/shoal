/**
 * providers.ts — the single source of truth for what an LLM provider is.
 *
 * Facts about a provider were spread across five files: the default-model
 * table and the OpenAI-compat table in llm-client.ts, `FREE_PROVIDERS` in
 * cost.ts, the credential and subscription sets in doctor.ts, a switch in
 * load-env.ts, and the interactive list in bin/init.js. Adding one provider
 * meant editing most of them, and forgetting cost.ts meant a local provider
 * quietly priced as if it were metered.
 *
 * This module holds those facts once. It imports nothing from llm-client.ts,
 * so both the client factory and the cost/doctor layers can read it without a
 * cycle.
 */

/**
 * How a provider's client is constructed. Providers sharing a kind need no
 * new construction code at all — an OpenAI-compatible endpoint is one entry
 * in the table below and nothing else.
 */
export type ProviderKind = "anthropic" | "bedrock" | "openai-compat" | "codex" | "claude-cli";

export interface ProviderSpec {
  /** The value of `LLM_PROVIDER`. */
  id: string;
  /** Shown on the startup line. */
  label: string;
  /** How to build the client. */
  kind: ProviderKind;
  /**
   * Model used when `LLM_MODEL` is unset. Empty means the operator must name
   * one — true for local catalogs, which vary per machine.
   */
  defaultModel: string;
  /** Endpoint for `kind: "openai-compat"`. */
  baseURL?: string;
  /**
   * Env vars that can carry the credential, in precedence order. Empty means
   * the provider authenticates out-of-band (a subscription login) or runs
   * locally with no credential at all.
   */
  credentialEnv: string[];
  /**
   * True when there is no metered per-token charge to track: a local server,
   * or a flat-rate subscription. Cost estimation and the spend cap both read
   * this, so a new local provider cannot be mispriced by omission.
   */
  free: boolean;
  /** Authenticates through a separate login rather than an env var. */
  subscription?: boolean;
  /** Runs against a server on the operator's own machine. */
  local?: boolean;
}

/**
 * Every provider shoal knows. Adding one is an entry here — plus a pricing
 * table in cost.ts if it is metered, and a line in bin/init.js's prompt,
 * which `provider-defaults.test.ts` checks stays in step with this table.
 */
export const PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    // anthropic.claude-3-5-haiku-20241022-v1:0 (a previous default) is retired.
    defaultModel: "claude-haiku-4-5-20251001",
    credentialEnv: ["ANTHROPIC_API_KEY"],
    free: false,
  },
  {
    id: "bedrock",
    label: "Amazon Bedrock",
    kind: "bedrock",
    defaultModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
    // Empty rather than the AWS_* names: Bedrock falls back to the default
    // AWS credential chain (instance role, SSO, ~/.aws/credentials), so a
    // missing AWS_ACCESS_KEY_ID is not a misconfiguration.
    credentialEnv: [],
    free: false,
  },
  {
    id: "codex",
    label: "Codex (ChatGPT subscription)",
    kind: "codex",
    defaultModel: "gpt-5.1-codex-mini",
    credentialEnv: [],
    free: true,
    subscription: true,
  },
  {
    id: "claude-cli",
    label: "Claude CLI (Claude Code login)",
    kind: "claude-cli",
    defaultModel: "claude-sonnet-4-6",
    credentialEnv: [],
    free: true,
    subscription: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compat",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    credentialEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    free: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compat",
    baseURL: "https://openrouter.ai/api/v1",
    // google/gemini-flash-1.5 (a previous default) points at a retired
    // Gemini 1.5 generation; kept in step with the "gemini" entry below.
    defaultModel: "google/gemini-2.0-flash-001",
    credentialEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    free: false,
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai-compat",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    credentialEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    free: false,
  },
  {
    id: "gemini",
    label: "Gemini",
    kind: "openai-compat",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    credentialEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    free: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    kind: "openai-compat",
    baseURL: "http://localhost:11434/v1",
    // A common first pull; local catalogs vary, so the interactive prompt asks.
    defaultModel: "llama3.2",
    credentialEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    free: true,
    local: true,
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    kind: "openai-compat",
    baseURL: "http://localhost:1234/v1",
    // Deliberately empty: LM Studio names models per install, so guessing one
    // fails at the first call rather than at configuration time.
    defaultModel: "",
    credentialEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    free: true,
    local: true,
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** The spec for a provider id, or undefined for one shoal does not know. */
export function findProvider(id: string): ProviderSpec | undefined {
  return BY_ID.get(id);
}

/**
 * Providers with no metered per-token charge — local servers and flat-rate
 * subscriptions. Derived rather than hand-listed so a new local provider
 * cannot be priced as metered by omission. `"local"` is kept as an accepted
 * value for hand-written run logs that predate the registry.
 */
export const FREE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...PROVIDERS.filter((p) => p.free).map((p) => p.id),
  "local",
]);

/** Providers that authenticate through a separate login rather than an env var. */
export const SUBSCRIPTION_PROVIDER_IDS: ReadonlySet<string> = new Set(
  PROVIDERS.filter((p) => p.subscription).map((p) => p.id),
);

/** Providers that talk to a server on the operator's own machine. */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(
  PROVIDERS.filter((p) => p.local).map((p) => p.id),
);

/**
 * Default model per provider id.
 *
 * Kept as a plain record because `bin/init.js` runs as plain JS and cannot
 * import this module; `framework/__tests__/provider-defaults.test.ts` checks
 * its copy against this one, so a retired model id has one place to fix.
 */
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.defaultModel]),
);

/** First credential env var that is actually set, or null. */
export function resolveCredential(
  spec: ProviderSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const name of spec.credentialEnv) {
    const value = env[name];
    if (value) return value;
  }
  return null;
}
