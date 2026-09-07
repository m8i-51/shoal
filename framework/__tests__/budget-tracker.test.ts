import { describe, it, expect } from "vitest";
import { BudgetExceededError, BudgetTracker } from "../budget";

const MODEL = "claude-haiku-4-5-20251001";
const PROVIDER = "anthropic";

describe("BudgetTracker", () => {
  it("インスタンスごとに状態が独立している", () => {
    // The point of the refactor: before this, one tracker exhausting the cap
    // left the module "exceeded" for whatever ran next.
    const spent = new BudgetTracker(0.0001);
    const fresh = new BudgetTracker(0.0001);

    spent.recordSpend(MODEL, PROVIDER, 1_000_000, 1_000_000);

    expect(spent.exceeded).toBe(true);
    expect(fresh.exceeded).toBe(false);
    expect(() => spent.assertWithinBudget()).toThrow(BudgetExceededError);
    expect(() => fresh.assertWithinBudget()).not.toThrow();
  });

  it("上限なしなら決して超過しない", () => {
    const tracker = new BudgetTracker(null);
    tracker.recordSpend(MODEL, PROVIDER, 10_000_000, 10_000_000);
    expect(tracker.exceeded).toBe(false);
    expect(() => tracker.assertWithinBudget()).not.toThrow();
    expect(tracker.statusLine()).toBeNull();
  });

  it("価格不明のモデルは加算せず、記録だけ残す", () => {
    const tracker = new BudgetTracker(1);
    const after = tracker.recordSpend("no-such-model", "openrouter", 1_000_000, 1_000_000);
    expect(after).toBe(0);
    expect(tracker.exceeded).toBe(false);
    expect(tracker.stopLine()).toContain("no known price");
  });

  it("ローカルプロバイダは課金対象にならない", () => {
    const tracker = new BudgetTracker(1);
    tracker.recordSpend("llama3.2", "ollama", 1_000_000, 1_000_000);
    expect(tracker.state.spentUSD).toBe(0);
  });

  it("fromEnv が SHOAL_MAX_USD を読む", () => {
    expect(BudgetTracker.fromEnv({ SHOAL_MAX_USD: "2.5" }).state.limitUSD).toBe(2.5);
    expect(BudgetTracker.fromEnv({}).state.limitUSD).toBeNull();
  });

  it("上限に達したところで exceeded になる", () => {
    const tracker = new BudgetTracker(1);
    tracker.recordSpend(MODEL, PROVIDER, 100, 100);
    expect(tracker.exceeded).toBe(false);
    tracker.recordSpend(MODEL, PROVIDER, 10_000_000, 10_000_000);
    expect(tracker.exceeded).toBe(true);
  });
});
