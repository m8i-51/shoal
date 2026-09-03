import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveBenchModelLabel } from "../index";

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_MODEL", "SHOAL_MODEL"] as const;
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

describe("resolveBenchModelLabel", () => {
  it("既定（LLM_PROVIDER 未設定）は anthropic とその既定モデルを返す", () => {
    expect(resolveBenchModelLabel()).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("LLM_MODEL を設定すればそれを反映する — ANTHROPIC_MODEL / OPENAI_MODEL / SHOAL_MODEL は存在しない変数なので無視されるべき", () => {
    process.env.LLM_MODEL = "claude-opus-4-7";
    // shoal はこれらの変数を一切読まない。bench が誤って読んでいた過去のバグの再発防止。
    process.env.ANTHROPIC_MODEL = "should-be-ignored";
    process.env.OPENAI_MODEL = "should-be-ignored";
    process.env.SHOAL_MODEL = "should-be-ignored";
    expect(resolveBenchModelLabel()).toBe("anthropic/claude-opus-4-7");
  });

  it("LLM_PROVIDER=bedrock ならプロバイダ名とモデルの両方が反映される", () => {
    process.env.LLM_PROVIDER = "bedrock";
    expect(resolveBenchModelLabel()).toBe("bedrock/anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("常に 'unknown' ではない具体的な値を返す（過去の回帰の再発防止）", () => {
    expect(resolveBenchModelLabel()).not.toContain("unknown");
  });
});
