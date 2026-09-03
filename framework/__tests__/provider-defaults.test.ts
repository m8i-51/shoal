import { describe, it, expect } from "vitest";
import { PROVIDER_DEFAULT_MODELS } from "../llm-client";
import { PROVIDERS as INIT_PROVIDERS } from "../../bin/init.js";

/**
 * `bin/init.js` runs as plain JS (no tsx), so it cannot import
 * `framework/llm-client.ts`'s PROVIDER_DEFAULT_MODELS directly and carries its
 * own copy for the interactive prompt. That duplication is exactly how a
 * retired model (Bedrock's anthropic.claude-3-5-haiku-20241022-v1:0, an
 * OpenRouter default pointing at a retired Gemini 1.5 generation) ended up
 * fixed in one place and stale in the other. This test is the guard against
 * that happening again silently.
 */
describe("provider default models stay in sync between llm-client.ts and bin/init.js", () => {
  it("bin/init.js's prompt default matches framework/llm-client.ts's runtime default for every provider that has one", () => {
    for (const p of INIT_PROVIDERS) {
      // ollama / lm-studio deliberately have no suggested default in the
      // interactive prompt (local catalogs vary per machine) even though the
      // runtime falls back to one when LLM_MODEL is omitted entirely.
      if (p.defaultModel == null) continue;
      expect(PROVIDER_DEFAULT_MODELS[p.value], `provider "${p.value}"`).toBe(p.defaultModel);
    }
  });

  it("every bin/init.js provider is a known runtime provider", () => {
    for (const p of INIT_PROVIDERS) {
      expect(Object.hasOwn(PROVIDER_DEFAULT_MODELS, p.value), `provider "${p.value}"`).toBe(true);
    }
  });
});
