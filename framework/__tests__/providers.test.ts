import { describe, it, expect } from "vitest";
import {
  FREE_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  PROVIDERS,
  PROVIDER_DEFAULT_MODELS,
  SUBSCRIPTION_PROVIDER_IDS,
  findProvider,
  resolveCredential,
} from "../providers";

describe("PROVIDERS", () => {
  it("id が重複していない", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("openai-compat のプロバイダは baseURL を持つ", () => {
    for (const p of PROVIDERS.filter((p) => p.kind === "openai-compat")) {
      expect(p.baseURL, `${p.id} has no baseURL`).toBeTruthy();
    }
  });

  it("openai-compat 以外は baseURL を持たない", () => {
    for (const p of PROVIDERS.filter((p) => p.kind !== "openai-compat")) {
      expect(p.baseURL, `${p.id} should not carry a baseURL`).toBeUndefined();
    }
  });

  it("ローカル/サブスクリプションのプロバイダは必ず free（課金対象として誤計上しない）", () => {
    for (const p of PROVIDERS) {
      if (p.local || p.subscription) {
        expect(p.free, `${p.id} is local/subscription but not marked free`).toBe(true);
      }
    }
  });

  it("サブスクリプションのプロバイダは資格情報の環境変数を持たない", () => {
    for (const p of PROVIDERS.filter((p) => p.subscription)) {
      expect(p.credentialEnv).toEqual([]);
    }
  });
});

describe("derived sets", () => {
  it("FREE_PROVIDER_IDS は free フラグから導出される", () => {
    for (const p of PROVIDERS) {
      expect(FREE_PROVIDER_IDS.has(p.id)).toBe(p.free);
    }
  });

  it('過去のログにある "local" も無償として受け付ける', () => {
    expect(FREE_PROVIDER_IDS.has("local")).toBe(true);
  });

  it("SUBSCRIPTION / LOCAL の集合がフラグと一致する", () => {
    expect([...SUBSCRIPTION_PROVIDER_IDS].sort()).toEqual(["claude-cli", "codex"]);
    expect([...LOCAL_PROVIDER_IDS].sort()).toEqual(["lm-studio", "ollama"]);
  });

  it("PROVIDER_DEFAULT_MODELS が全プロバイダを網羅する", () => {
    expect(Object.keys(PROVIDER_DEFAULT_MODELS).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
  });
});

describe("findProvider", () => {
  it("既知の id を返し、未知の id は undefined", () => {
    expect(findProvider("anthropic")?.kind).toBe("anthropic");
    expect(findProvider("not-a-provider")).toBeUndefined();
  });
});

describe("resolveCredential", () => {
  it("優先順に最初に設定されている値を返す", () => {
    const spec = findProvider("openai")!;
    expect(resolveCredential(spec, { OPENAI_API_KEY: "b" })).toBe("b");
    expect(resolveCredential(spec, { LLM_API_KEY: "a", OPENAI_API_KEY: "b" })).toBe("a");
  });

  it("どれも設定されていなければ null", () => {
    expect(resolveCredential(findProvider("openai")!, {})).toBeNull();
  });

  it("環境変数を使わないプロバイダは常に null", () => {
    expect(resolveCredential(findProvider("claude-cli")!, { ANTHROPIC_API_KEY: "x" })).toBeNull();
  });
});
