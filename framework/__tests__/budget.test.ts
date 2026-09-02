import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  BudgetExceededError,
  assertWithinBudget,
  budgetStatusLine,
  budgetStopLine,
  getBudgetState,
  initBudget,
  isBudgetExceeded,
  recordSpend,
  resolveBudgetLimit,
} from "../budget";

const HAIKU = "claude-haiku-4-5-20251001"; // $0.8/M in, $4/M out

describe("resolveBudgetLimit", () => {
  it("未設定なら上限なし", () => {
    expect(resolveBudgetLimit({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveBudgetLimit({ SHOAL_MAX_USD: "  " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("正の数を上限として読む", () => {
    expect(resolveBudgetLimit({ SHOAL_MAX_USD: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(resolveBudgetLimit({ SHOAL_MAX_USD: "0.25" } as NodeJS.ProcessEnv)).toBe(0.25);
  });

  it("不正値は上限なしに倒す（誤って run を即死させない）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveBudgetLimit({ SHOAL_MAX_USD: "abc" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveBudgetLimit({ SHOAL_MAX_USD: "0" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveBudgetLimit({ SHOAL_MAX_USD: "-3" } as NodeJS.ProcessEnv)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("budget accounting", () => {
  beforeEach(() => {
    initBudget({ SHOAL_MAX_USD: "1" } as NodeJS.ProcessEnv);
  });

  afterEach(() => {
    initBudget({} as NodeJS.ProcessEnv);
  });

  it("上限内なら通す", () => {
    recordSpend(HAIKU, "anthropic", 1000, 1000);
    expect(isBudgetExceeded()).toBe(false);
    expect(() => assertWithinBudget()).not.toThrow();
    expect(getBudgetState().spentUSD).toBeCloseTo(0.0048, 6);
  });

  it("上限に達したら以降の呼び出しを拒否する", () => {
    // 1M in + 1M out = $0.8 + $4.0 = $4.8 > $1
    recordSpend(HAIKU, "anthropic", 1_000_000, 1_000_000);
    expect(isBudgetExceeded()).toBe(true);
    expect(() => assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it("ちょうど上限に達した時点で止める", () => {
    initBudget({ SHOAL_MAX_USD: "0.0008" } as NodeJS.ProcessEnv);
    recordSpend(HAIKU, "anthropic", 1000, 0); // exactly $0.0008
    expect(isBudgetExceeded()).toBe(true);
  });

  it("上限未設定なら何回呼んでも止まらない", () => {
    initBudget({} as NodeJS.ProcessEnv);
    recordSpend(HAIKU, "anthropic", 10_000_000, 10_000_000);
    expect(isBudgetExceeded()).toBe(false);
    expect(() => assertWithinBudget()).not.toThrow();
  });

  it("価格不明のモデルは 0 として扱い、上限では止めない", () => {
    recordSpend("some-unknown-model", "anthropic", 10_000_000, 10_000_000);
    expect(getBudgetState().spentUSD).toBe(0);
    expect(getBudgetState().sawUnpricedCall).toBe(true);
    expect(isBudgetExceeded()).toBe(false);
  });

  it("サブスク系プロバイダは課金対象外", () => {
    recordSpend(HAIKU, "claude-cli", 10_000_000, 10_000_000);
    expect(getBudgetState().spentUSD).toBe(0);
    expect(isBudgetExceeded()).toBe(false);
  });

  it("複数回の呼び出しが積み上がる", () => {
    recordSpend(HAIKU, "anthropic", 100_000, 100_000); // $0.48
    expect(isBudgetExceeded()).toBe(false);
    recordSpend(HAIKU, "anthropic", 100_000, 100_000); // $0.96
    expect(isBudgetExceeded()).toBe(false);
    recordSpend(HAIKU, "anthropic", 100_000, 100_000); // $1.44 > $1
    expect(isBudgetExceeded()).toBe(true);
  });
});

describe("budget messages", () => {
  it("上限未設定なら起動行を出さない", () => {
    initBudget({} as NodeJS.ProcessEnv);
    expect(budgetStatusLine()).toBeNull();
  });

  it("上限があれば金額を出す", () => {
    initBudget({ SHOAL_MAX_USD: "2.5" } as NodeJS.ProcessEnv);
    expect(budgetStatusLine()).toContain("$2.50");
  });

  it("停止行に実績と上限を含める", () => {
    initBudget({ SHOAL_MAX_USD: "1" } as NodeJS.ProcessEnv);
    recordSpend(HAIKU, "anthropic", 1_000_000, 1_000_000);
    const line = budgetStopLine();
    expect(line).toContain("$1.00");
    expect(line).toContain("4.8");
  });

  it("価格不明の呼び出しがあった場合は但し書きを添える", () => {
    initBudget({ SHOAL_MAX_USD: "1" } as NodeJS.ProcessEnv);
    recordSpend("unknown-model", "anthropic", 100, 100);
    expect(budgetStopLine()).toContain("no known price");
  });
});
