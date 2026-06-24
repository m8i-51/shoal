import { describe, it, expect, vi, beforeEach } from "vitest";
import { estimateCost, formatCostUSD } from "../cost";

// OpenRouter のフェッチをモック（ネットワーク不要）
vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    status: 503,
    json: async () => ({}),
    text: async () => "",
  } as Response);
});

describe("formatCostUSD", () => {
  it("null / undefined は —", () => {
    expect(formatCostUSD(null)).toBe("—");
    expect(formatCostUSD(undefined)).toBe("—");
  });

  it("0 は < $0.0001", () => {
    expect(formatCostUSD(0)).toBe("< $0.0001");
  });

  it("負値は < $0.0001", () => {
    expect(formatCostUSD(-1)).toBe("< $0.0001");
  });

  it("0.0001 ちょうどは 4 桁小数", () => {
    expect(formatCostUSD(0.0001)).toBe("$0.0001");
  });

  it("0.00005 未満は < $0.0001", () => {
    expect(formatCostUSD(0.000005)).toBe("< $0.0001");
  });

  it("0.0001 以上 0.01 未満は 4 桁小数", () => {
    expect(formatCostUSD(0.0023)).toBe("$0.0023");
  });

  it("0.01 以上 1 未満は 3 桁小数", () => {
    expect(formatCostUSD(0.123)).toBe("$0.123");
  });

  it("1 以上は 2 桁小数", () => {
    expect(formatCostUSD(2.5)).toBe("$2.50");
  });
});

describe("estimateCost — free providers", () => {
  it.each(["ollama", "lm-studio", "codex", "local"])("%s は null を返す", async (provider) => {
    expect(await estimateCost("any-model", provider, 1000, 500)).toBeNull();
  });
});

describe("estimateCost — Anthropic", () => {
  it("claude-haiku-4-5-20251001 の料金を計算する", async () => {
    const cost = await estimateCost("claude-haiku-4-5-20251001", "anthropic", 1_000_000, 500_000);
    // input: 0.8/1M × 1M = 0.8, output: 4/1M × 500k = 2.0 → 2.8
    expect(cost).toBeCloseTo(2.8, 5);
  });

  it("prefix match — claude-haiku-4-5-xxx はキーに一致する", async () => {
    const cost = await estimateCost("claude-haiku-4-5-some-suffix", "anthropic", 1_000_000, 0);
    expect(cost).toBeCloseTo(0.8, 5);
  });

  it("不明モデルは null", async () => {
    expect(await estimateCost("claude-unknown-9999", "anthropic", 1000, 500)).toBeNull();
  });

  it("claude-sonnet-4-6 の料金を計算する", async () => {
    const cost = await estimateCost("claude-sonnet-4-6", "anthropic", 1_000_000, 1_000_000);
    // input: 3/1M + output: 15/1M = 18
    expect(cost).toBeCloseTo(18, 5);
  });
});

describe("estimateCost — Bedrock", () => {
  it("anthropic.claude-3-5-haiku-20241022-v1:0 の料金を計算する", async () => {
    const cost = await estimateCost("anthropic.claude-3-5-haiku-20241022-v1:0", "bedrock", 1_000_000, 1_000_000);
    // input: 0.8/1M + output: 4/1M = 4.8
    expect(cost).toBeCloseTo(4.8, 5);
  });

  it("クロスリージョンプレフィックス us. を除去してマッチする", async () => {
    const direct = await estimateCost("anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock", 1_000_000, 0);
    const crossRegion = await estimateCost("us.anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock", 1_000_000, 0);
    expect(crossRegion).toBeCloseTo(direct!, 8);
  });

  it("不明モデルは null", async () => {
    expect(await estimateCost("anthropic.claude-unknown-v99:0", "bedrock", 1000, 500)).toBeNull();
  });
});

describe("estimateCost — OpenAI", () => {
  it("gpt-4o の料金を計算する", async () => {
    const cost = await estimateCost("gpt-4o", "openai", 1_000_000, 1_000_000);
    // input: 5/1M + output: 15/1M = 20
    expect(cost).toBeCloseTo(20, 5);
  });

  it("gpt-4o-mini の料金を計算する", async () => {
    const cost = await estimateCost("gpt-4o-mini", "openai", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 5);
  });

  it("不明モデルは null", async () => {
    expect(await estimateCost("gpt-unknown", "openai", 1000, 500)).toBeNull();
  });
});

describe("estimateCost — OpenRouter", () => {
  it("fetch 失敗時は null を返す", async () => {
    expect(await estimateCost("some/model", "openrouter", 1000, 500)).toBeNull();
  });

  it("fetch 成功時はレスポンスの料金を使う", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "some/model", pricing: { prompt: "0.000003", completion: "0.000015" } }],
      }),
    } as Response);
    const cost = await estimateCost("some/model", "openrouter", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 5);
  });

  it("TTL 以内の再呼び出しはキャッシュを使い fetch を呼ばない", async () => {
    // 直前のテストで openrouterCache が温まっている前提（モジュールレベルで共有）
    vi.mocked(fetch).mockClear();
    const cost = await estimateCost("some/model", "openrouter", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 5);
    expect(fetch).not.toHaveBeenCalled();
  });
});
