import { describe, it, expect } from "vitest";
import { SecretRegistry } from "../trace-scrub";

describe("SecretRegistry", () => {
  it("インスタンスごとに独立している（リセット不要）", () => {
    // The old module-level Set needed a "test-only" clearKnownSecrets();
    // separate instances make that unnecessary.
    const a = new SecretRegistry();
    const b = new SecretRegistry();
    a.add("hunter2-and-then-some");
    expect(a.list()).toEqual(["hunter2-and-then-some"]);
    expect(b.list()).toEqual([]);
  });

  it("最小長 (4) 未満の値は登録しない", () => {
    // Below the threshold a "secret" would match half the trace and redact it.
    const registry = new SecretRegistry();
    registry.add("abc");
    registry.add("");
    expect(registry.list()).toEqual([]);
    registry.add("abcd");
    expect(registry.list()).toEqual(["abcd"]);
  });

  it("undefined / null を飛ばして複数登録できる", () => {
    const registry = new SecretRegistry();
    registry.addAll(["a-long-enough-secret", undefined, null, "another-long-secret"]);
    expect(registry.list().sort()).toEqual(["a-long-enough-secret", "another-long-secret"]);
  });

  it("同じ値は重複しない", () => {
    const registry = new SecretRegistry();
    registry.add("a-long-enough-secret");
    registry.add("a-long-enough-secret");
    expect(registry.list()).toHaveLength(1);
  });
});
