import { describe, it, expect } from "vitest";
import { normalizeRole, roleAffinity, findBestByRole } from "../role-match";

describe("normalizeRole", () => {
  it("前後空白を落とし、大文字小文字と区切りを揃える", () => {
    expect(normalizeRole("  Instructor ")).toBe("instructor");
    expect(normalizeRole("math_instructor")).toBe("math instructor");
    expect(normalizeRole("Learner-guest")).toBe("learner guest");
  });

  it("undefined / null / 空文字は空文字に正規化する（TypeError にしない）", () => {
    expect(normalizeRole(undefined)).toBe("");
    expect(normalizeRole(null)).toBe("");
    expect(normalizeRole("")).toBe("");
    expect(normalizeRole("   ")).toBe("");
  });
});

describe("roleAffinity", () => {
  it("完全一致は最高スコア", () => {
    expect(roleAffinity("instructor", "instructor")).toBeGreaterThan(roleAffinity("instructor", "learner"));
    expect(roleAffinity("講師", "講師")).toBe(roleAffinity("instructor", "instructor"));
  });

  it("大文字小文字が違っても一致する", () => {
    expect(roleAffinity("Instructor", "instructor")).toBeGreaterThan(0);
    expect(roleAffinity("ADMIN", "admin")).toBe(roleAffinity("admin", "admin"));
  });

  it("複合ペルソナ role からアクター role を拾う", () => {
    expect(roleAffinity("Math Instructor", "instructor")).toBeGreaterThan(0);
    expect(roleAffinity("未ログイン学習者", "学習者")).toBeGreaterThan(0);
    expect(roleAffinity("数学講師", "講師")).toBeGreaterThan(0);
  });

  it("administrator と admin のような包含でも一致する", () => {
    expect(roleAffinity("administrator", "admin")).toBeGreaterThan(0);
  });

  it("無関係な role は 0", () => {
    expect(roleAffinity("learner", "instructor")).toBe(0);
    expect(roleAffinity("explorer", "member")).toBe(0);
    expect(roleAffinity("", "admin")).toBe(0);
  });

  it("片側が undefined / null でも 0 を返し落ちない", () => {
    expect(roleAffinity(undefined as unknown as string, "admin")).toBe(0);
    expect(roleAffinity("admin", undefined as unknown as string)).toBe(0);
    expect(roleAffinity(null as unknown as string, null as unknown as string)).toBe(0);
  });
});

describe("findBestByRole", () => {
  it("完全一致を部分一致より優先する", () => {
    const items = [
      { role: "superadmin", id: "1" },
      { role: "admin", id: "2" },
    ];
    expect(findBestByRole(items, "admin")?.id).toBe("2");
  });

  it("一致が無ければ undefined", () => {
    expect(findBestByRole([{ role: "member", id: "1" }], "explorer")).toBeUndefined();
  });

  it("roster に空 role の壊れた項目があっても突き合わせを継続する", () => {
    const items = [
      { role: undefined as unknown as string, id: "broken" },
      { role: "admin", id: "ok" },
    ];
    expect(findBestByRole(items, "admin")?.id).toBe("ok");
    expect(findBestByRole(items, undefined as unknown as string)).toBeUndefined();
  });
});
