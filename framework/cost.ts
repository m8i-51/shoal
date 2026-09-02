// Per-token USD prices (as of 2026-04)
const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 5.x
  "claude-fable-5":             { input: 10 / 1e6,  output: 50 / 1e6  },
  "claude-mythos-5":            { input: 10 / 1e6,  output: 50 / 1e6  },
  "claude-opus-5":              { input: 5 / 1e6,   output: 25 / 1e6  },
  "claude-sonnet-5":            { input: 2 / 1e6,   output: 10 / 1e6  },
  // Claude 4.x Opus
  "claude-opus-4-8":            { input: 5 / 1e6,   output: 25 / 1e6  },
  "claude-opus-4-7":            { input: 5 / 1e6,   output: 25 / 1e6  },
  "claude-opus-4-6":            { input: 5 / 1e6,   output: 25 / 1e6  },
  "claude-opus-4-5":            { input: 5 / 1e6,   output: 25 / 1e6  },
  "claude-opus-4-1":            { input: 15 / 1e6,  output: 75 / 1e6  },
  "claude-opus-4":              { input: 15 / 1e6,  output: 75 / 1e6  },
  // Claude 4.x Sonnet
  "claude-sonnet-4-6":          { input: 3 / 1e6,   output: 15 / 1e6  },
  "claude-sonnet-4-5":          { input: 3 / 1e6,   output: 15 / 1e6  },
  "claude-sonnet-4":            { input: 3 / 1e6,   output: 15 / 1e6  },
  // Claude 4.x Haiku
  "claude-haiku-4-5-20251001":  { input: 0.8 / 1e6, output: 4 / 1e6   },
  "claude-haiku-4-5":           { input: 0.8 / 1e6, output: 4 / 1e6   },
  // Claude 3.7
  "claude-3-7-sonnet-20250219": { input: 3 / 1e6,   output: 15 / 1e6  },
  "claude-3-7-sonnet":          { input: 3 / 1e6,   output: 15 / 1e6  },
  // Claude 3.5
  "claude-3-5-sonnet-20241022": { input: 3 / 1e6,   output: 15 / 1e6  },
  "claude-3-5-sonnet-20240620": { input: 3 / 1e6,   output: 15 / 1e6  },
  "claude-3-5-haiku-20241022":  { input: 0.8 / 1e6, output: 4 / 1e6   },
  // Claude 3
  "claude-3-opus-20240229":     { input: 15 / 1e6,  output: 75 / 1e6  },
  "claude-3-sonnet-20240229":   { input: 3 / 1e6,   output: 15 / 1e6  },
  "claude-3-haiku-20240307":    { input: 0.25 / 1e6, output: 1.25 / 1e6 },
};

// Bedrock on-demand pricing (us-east-1, as of 2026-04)
const BEDROCK_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 5.x
  "anthropic.claude-opus-5-v1":                { input: 5 / 1e6,   output: 25 / 1e6  },
  "anthropic.claude-sonnet-5-v1":              { input: 2 / 1e6,   output: 10 / 1e6  },
  "anthropic.claude-fable-5-v1":               { input: 10 / 1e6,  output: 50 / 1e6  },
  // Claude 4.x Opus
  "anthropic.claude-opus-4-8-v1":              { input: 5 / 1e6,   output: 25 / 1e6  },
  "anthropic.claude-opus-4-7-v1:0":            { input: 5 / 1e6,   output: 25 / 1e6  },
  "anthropic.claude-opus-4-6-v1":              { input: 5 / 1e6,   output: 25 / 1e6  },
  "anthropic.claude-opus-4-5-20251101-v1:0":   { input: 5 / 1e6,   output: 25 / 1e6  },
  "anthropic.claude-opus-4-1-20250805-v1:0":   { input: 15 / 1e6,  output: 75 / 1e6  },
  "anthropic.claude-opus-4-20250514-v1:0":     { input: 15 / 1e6,  output: 75 / 1e6  },
  // Claude 4.x Sonnet
  "anthropic.claude-sonnet-4-6":               { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-sonnet-4-6-v1:0":          { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-sonnet-4-20250514-v1:0":   { input: 3 / 1e6,   output: 15 / 1e6  },
  // Claude 4.x Haiku
  "anthropic.claude-haiku-4-5-20251001-v1:0":  { input: 0.8 / 1e6, output: 4 / 1e6   },
  // Claude 3.7
  "anthropic.claude-3-7-sonnet-20250219-v1:0": { input: 3 / 1e6,   output: 15 / 1e6  },
  // Claude 3.5
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-3-5-sonnet-20241022-v1:0": { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-3-5-sonnet-20240620-v1:0": { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-3-5-haiku-20241022-v1:0":  { input: 0.8 / 1e6, output: 4 / 1e6   },
  // Claude 3
  "anthropic.claude-3-opus-20240229-v1:0":     { input: 15 / 1e6,  output: 75 / 1e6  },
  "anthropic.claude-3-sonnet-20240229-v1:0":   { input: 3 / 1e6,   output: 15 / 1e6  },
  "anthropic.claude-3-haiku-20240307-v1:0":    { input: 0.25 / 1e6, output: 1.25 / 1e6 },
};

const BEDROCK_REGION_PREFIX = /^(?:global|us|eu|jp|apac)\./;

function stripBedrockRegionPrefix(model: string): string {
  return model.replace(BEDROCK_REGION_PREFIX, "");
}

function bedrockModelToAnthropicKey(model: string): string {
  return stripBedrockRegionPrefix(model)
    .replace(/^anthropic\./, "")
    .replace(/-v\d+(?::0)?$/, "");
}

function lookupAnthropicPricing(modelKey: string): { input: number; output: number } | undefined {
  const pricing = ANTHROPIC_PRICING[modelKey];
  if (pricing) return pricing;
  const key = Object.keys(ANTHROPIC_PRICING).find((k) => modelKey.startsWith(k));
  return key ? ANTHROPIC_PRICING[key] : undefined;
}

function lookupBedrockPricing(model: string): { input: number; output: number } | undefined {
  const candidates = [model, stripBedrockRegionPrefix(model)];

  for (const id of candidates) {
    if (BEDROCK_PRICING[id]) return BEDROCK_PRICING[id];
  }

  for (const id of candidates) {
    const key = Object.keys(BEDROCK_PRICING).find((k) => id.startsWith(k) || k.startsWith(id));
    if (key) return BEDROCK_PRICING[key];
  }

  for (const id of candidates) {
    const pricing = lookupAnthropicPricing(bedrockModelToAnthropicKey(id));
    if (pricing) return pricing;
  }

  return undefined;
}

const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":           { input: 5 / 1e6,    output: 15 / 1e6  },
  "gpt-4o-mini":      { input: 0.15 / 1e6, output: 0.6 / 1e6 },
  "gpt-4-turbo":      { input: 10 / 1e6,   output: 30 / 1e6  },
  "o1":               { input: 15 / 1e6,   output: 60 / 1e6  },
  "o1-mini":          { input: 3 / 1e6,    output: 12 / 1e6  },
  "o3-mini":          { input: 1.1 / 1e6,  output: 4.4 / 1e6 },
  "o3":               { input: 10 / 1e6,   output: 40 / 1e6  },
};

// Local / subscription providers — cost tracking not applicable
const FREE_PROVIDERS = new Set(["ollama", "lm-studio", "codex", "claude-cli", "local"]);

let openrouterCache: Map<string, { input: number; output: number }> | null = null;
let openrouterCachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchOpenRouterPricing(): Promise<Map<string, { input: number; output: number }>> {
  if (openrouterCache && Date.now() - openrouterCachedAt < CACHE_TTL_MS) {
    return openrouterCache;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as {
      data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const map = new Map<string, { input: number; output: number }>();
    for (const m of data.data) {
      const inp = parseFloat(m.pricing?.prompt ?? "0");
      const out = parseFloat(m.pricing?.completion ?? "0");
      if (inp >= 0 && out >= 0) map.set(m.id, { input: inp, output: out });
    }
    openrouterCache = map;
    openrouterCachedAt = Date.now();
    console.log(`[cost] OpenRouter pricing loaded (${map.size} models)`);
    return map;
  } catch (e) {
    console.warn("[cost] OpenRouter pricing fetch failed:", String(e));
    return openrouterCache ?? new Map();
  }
}

/**
 * Price lookup that never performs I/O. OpenRouter is only priced when its
 * catalogue is already cached, so callers on a hot path (budget accounting)
 * stay synchronous.
 */
function lookupPricingSync(
  model: string,
  provider: string,
): { input: number; output: number } | undefined {
  // Callers on the budget path may not know the model (a stubbed client, a
  // provider that omits it) — unknown means unpriced, never free.
  if (typeof model !== "string" || model === "") return undefined;
  if (FREE_PROVIDERS.has(provider)) return undefined;
  if (provider === "anthropic") return lookupAnthropicPricing(model);
  if (provider === "bedrock") return lookupBedrockPricing(model);
  if (provider === "openai") return OPENAI_PRICING[model];
  if (provider === "openrouter") return openrouterCache?.get(model);
  return undefined;
}

/**
 * Synchronous cost estimate. Returns null when the model/provider has no known
 * price — callers must treat null as "unknown", not as "free".
 */
export function estimateCostSync(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = lookupPricingSync(model, provider);
  if (!pricing) return null;
  return pricing.input * inputTokens + pricing.output * outputTokens;
}

export async function estimateCost(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number | null> {
  if (FREE_PROVIDERS.has(provider)) return null;

  if (provider === "openrouter") {
    const map = await fetchOpenRouterPricing();
    const pricing = map.get(model);
    if (!pricing) return null;
    return pricing.input * inputTokens + pricing.output * outputTokens;
  }

  return estimateCostSync(model, provider, inputTokens, outputTokens);
}

export function formatCostUSD(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.0001) return "< $0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
