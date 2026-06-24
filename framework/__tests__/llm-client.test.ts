import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLLMClient } from "../llm-client";

const ENV_KEYS = [
  "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_REGION",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("createLLMClient", () => {
  it("デフォルト（LLM_PROVIDER 未設定）は anthropic、モデルは claude-haiku-4-5-20251001", () => {
    const result = createLLMClient();
    expect(result.provider).toBe("anthropic");
    expect(result.defaultModel).toBe("claude-haiku-4-5-20251001");
    expect(typeof result.client.createMessage).toBe("function");
  });

  it("LLM_MODEL を設定すると anthropic のデフォルトモデルを上書きする", () => {
    process.env.LLM_MODEL = "claude-opus-4-7";
    expect(createLLMClient().defaultModel).toBe("claude-opus-4-7");
  });

  it('LLM_PROVIDER=bedrock の場合は provider:"bedrock"、デフォルトモデルは haiku', () => {
    process.env.LLM_PROVIDER = "bedrock";
    const result = createLLMClient();
    expect(result.provider).toBe("bedrock");
    expect(result.defaultModel).toBe("anthropic.claude-3-5-haiku-20241022-v1:0");
  });

  it("bedrock でも LLM_MODEL で上書きできる", () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.LLM_MODEL = "custom-bedrock-model";
    expect(createLLMClient().defaultModel).toBe("custom-bedrock-model");
  });

  it('LLM_PROVIDER=codex の場合は provider:"codex"、デフォルトモデルは gpt-5.1-codex-mini', () => {
    process.env.LLM_PROVIDER = "codex";
    const result = createLLMClient();
    expect(result.provider).toBe("codex");
    expect(result.defaultModel).toBe("gpt-5.1-codex-mini");
  });

  it.each([
    ["ollama", "http://localhost:11434/v1", "llama3.2"],
    ["groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.0-flash"],
    ["openai", "https://api.openai.com/v1", "gpt-4o-mini"],
    ["openrouter", "https://openrouter.ai/api/v1", "google/gemini-flash-1.5"],
  ])("LLM_PROVIDER=%s は既知の baseURL/デフォルトモデルを使う", (provider, _baseUrl, defaultModel) => {
    process.env.LLM_PROVIDER = provider;
    const result = createLLMClient();
    expect(result.provider).toBe(provider);
    expect(result.defaultModel).toBe(defaultModel);
  });

  it("既知プロバイダでも LLM_BASE_URL があればそちらを優先する", () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LLM_BASE_URL = "http://custom-host:9999/v1";
    // 戻り値からは baseURL は見えないが、エラーにならず構築できることを確認
    expect(() => createLLMClient()).not.toThrow();
  });

  it("既知プロバイダでなくても LLM_BASE_URL があれば OpenAI 互換クライアントとして扱う", () => {
    process.env.LLM_PROVIDER = "my-custom-provider";
    process.env.LLM_BASE_URL = "http://localhost:8080/v1";
    const result = createLLMClient();
    expect(result.provider).toBe("my-custom-provider");
    expect(result.defaultModel).toBe("gpt-4o-mini");
  });

  it("LLM_API_KEY が無くても OPENAI_API_KEY をフォールバックに使う（エラーにならない）", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-fallback";
    expect(() => createLLMClient()).not.toThrow();
  });

  it("LLM_PROVIDER も LLM_BASE_URL も未知の場合は anthropic にフォールバックする", () => {
    process.env.LLM_PROVIDER = "totally-unknown-and-no-base-url";
    const result = createLLMClient();
    expect(result.provider).toBe("anthropic");
  });
});
