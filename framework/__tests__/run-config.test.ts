import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_BROWSER_ITERATIONS,
  DEFAULT_EXPLORER_CONCURRENCY,
  DEFAULT_VIEWPORT,
  browserIterations,
  explorerConcurrency,
  positiveIntFromEnv,
  resolveViewport,
  thresholdIterations,
} from "../run-config";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

describe("positiveIntFromEnv", () => {
  it("未設定なら既定値", () => {
    expect(positiveIntFromEnv("X", 12, { env: env({}) })).toBe(12);
    expect(positiveIntFromEnv("X", 12, { env: env({ X: "  " }) })).toBe(12);
  });

  it("整数を読む", () => {
    expect(positiveIntFromEnv("X", 12, { env: env({ X: "20" }) })).toBe(20);
  });

  it("範囲外・非整数は既定値に倒して警告する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(positiveIntFromEnv("X", 12, { max: 100, env: env({ X: "0" }) })).toBe(12);
    expect(positiveIntFromEnv("X", 12, { max: 100, env: env({ X: "500" }) })).toBe(12);
    expect(positiveIntFromEnv("X", 12, { env: env({ X: "3.5" }) })).toBe(12);
    expect(positiveIntFromEnv("X", 12, { env: env({ X: "twelve" }) })).toBe(12);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});

describe("lane limits", () => {
  it("既定値は抽出前の run.ts のリテラルと同じ", () => {
    expect(browserIterations(env({}))).toBe(DEFAULT_BROWSER_ITERATIONS);
    expect(thresholdIterations(env({}))).toBe(12);
    expect(explorerConcurrency(env({}))).toBe(DEFAULT_EXPLORER_CONCURRENCY);
  });

  it("環境変数で上書きできる", () => {
    expect(browserIterations(env({ SHOAL_BROWSER_ITERATIONS: "20" }))).toBe(20);
    expect(thresholdIterations(env({ SHOAL_THRESHOLD_ITERATIONS: "6" }))).toBe(6);
    expect(explorerConcurrency(env({ SHOAL_EXPLORER_CONCURRENCY: "4" }))).toBe(4);
  });
});

describe("resolveViewport", () => {
  it("既定は 1024x640", () => {
    expect(resolveViewport(env({}))).toEqual({ ...DEFAULT_VIEWPORT });
  });

  it("WIDTHxHEIGHT を読む", () => {
    expect(resolveViewport(env({ SHOAL_VIEWPORT: "1280x800" }))).toEqual({ width: 1280, height: 800 });
    expect(resolveViewport(env({ SHOAL_VIEWPORT: " 390 x 844 " }))).toEqual({ width: 390, height: 844 });
  });

  it("不正な指定は既定値に倒す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveViewport(env({ SHOAL_VIEWPORT: "huge" }))).toEqual({ ...DEFAULT_VIEWPORT });
    expect(resolveViewport(env({ SHOAL_VIEWPORT: "1280" }))).toEqual({ ...DEFAULT_VIEWPORT });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("既定値オブジェクトを共有しない（呼び出し側の変更が漏れない）", () => {
    const a = resolveViewport(env({}));
    a.width = 1;
    expect(resolveViewport(env({})).width).toBe(DEFAULT_VIEWPORT.width);
  });
});
