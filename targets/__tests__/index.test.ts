import { describe, it, expect, vi, afterEach } from "vitest";
import { applyLoadedTarget, loadTarget } from "../index";
import { noopTarget } from "../noop";
import type { TargetConfig } from "../types";

const base: TargetConfig = {
  appTools: [],
  execute: async () => ({ ok: true }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadTarget", () => {
  it("未知の名前は noop にフォールバックする", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadTarget("missing")).toBe(noopTarget);
    expect(warn).toHaveBeenCalled();
  });

  it("登録済みターゲットを返す", () => {
    expect(loadTarget("none")).toBe(noopTarget);
  });
});

describe("applyLoadedTarget", () => {
  it("appTools と execute がある場合はフルに置き換える", () => {
    const execute = async () => ({ items: [] });
    const loaded = {
      target: {
        appTools: [{ name: "list", description: "d", input_schema: { type: "object" as const, properties: {}, required: [] } }],
        execute,
        credentials: { email: "a@b.c", password: "p" },
      },
    };
    const result = applyLoadedTarget(base, loaded, "shoal.config.ts");
    expect(result.config.appTools).toHaveLength(1);
    expect(result.config.execute).toBe(execute);
    expect(result.config.credentials).toEqual({ email: "a@b.c", password: "p" });
    expect(result.messages[0]).toEqual({ level: "log", text: "[config] loaded: shoal.config.ts" });
  });

  it("ツールが無くても credentials は適用する", () => {
    const result = applyLoadedTarget(base, {
      target: { credentials: { email: "admin@example.com", password: "secret" } },
    }, "shoal.config.ts");
    expect(result.config.credentials).toEqual({ email: "admin@example.com", password: "secret" });
    expect(result.config.appTools).toBe(base.appTools);
    expect(result.messages[0].level).toBe("warn");
    expect(result.messages[0].text).toContain("applied credentials");
    expect(result.messages[0].text).toContain("no appTools/execute");
  });

  it("ツールが無くても projectPath は適用する", () => {
    const result = applyLoadedTarget(base, {
      target: { projectPath: "/tmp/app" },
    }, "shoal.config.js");
    expect(result.config.projectPath).toBe("/tmp/app");
    expect(result.messages[0].text).toContain("applied projectPath");
  });

  it("export default.target も読む", () => {
    const result = applyLoadedTarget(base, {
      default: { target: { credentials: { email: "d@e.f", password: "x" } } },
    }, "shoal.config.mjs");
    expect(result.config.credentials?.email).toBe("d@e.f");
  });

  it("target が無い場合は警告して現状維持", () => {
    const result = applyLoadedTarget(base, { other: true }, "shoal.config.ts");
    expect(result.config).toBe(base);
    expect(result.messages[0].text).toContain("does not export a valid target");
  });

  it("空の credentials は無視する", () => {
    const result = applyLoadedTarget(base, {
      target: { credentials: { email: "", password: "" } },
    }, "shoal.config.ts");
    expect(result.config).toBe(base);
    expect(result.messages[0].text).toContain("need appTools and execute");
  });
});
