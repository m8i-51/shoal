import { describe, it, expect, vi } from "vitest";
import {
  categoryFromLabels,
  pickByName,
  pickCatalogItem,
  toCatalogItems,
  type CatalogItem,
} from "../catalog-pick";

const TYPES: CatalogItem[] = [
  { id: "11", name: "バグ" },
  { id: "22", name: "タスク" },
  { id: "33", name: "要望" },
];

const PRIORITIES: CatalogItem[] = [
  { id: "2", name: "高" },
  { id: "3", name: "中" },
  { id: "4", name: "低" },
];

describe("categoryFromLabels", () => {
  it("既知カテゴリを labels から取り出す", () => {
    expect(categoryFromLabels(["bug", "feedback-agent"])).toBe("bug");
    expect(categoryFromLabels(["ux"])).toBe("ux");
    expect(categoryFromLabels(["feature-request"])).toBe("feature-request");
    expect(categoryFromLabels(["goal-gap"])).toBe("goal-gap");
  });

  it("regression は bug として扱う", () => {
    expect(categoryFromLabels(["regression", "feedback-agent"])).toBe("bug");
  });

  it("不明なラベルは ux にフォールバックする", () => {
    expect(categoryFromLabels(["feedback-agent"])).toBe("ux");
    expect(categoryFromLabels([])).toBe("ux");
  });
});

describe("pickByName", () => {
  it("bug は バグ を選ぶ", () => {
    expect(pickByName(TYPES, "bug", "issueType")).toEqual({ id: "11", name: "バグ" });
  });

  it("feature-request は 要望 を選ぶ", () => {
    expect(pickByName(TYPES, "feature-request", "issueType")).toEqual({ id: "33", name: "要望" });
  });

  it("ux は タスク、goal-gap は 要望 を選ぶ", () => {
    expect(pickByName(TYPES, "ux", "issueType")).toEqual({ id: "22", name: "タスク" });
    expect(pickByName(TYPES, "goal-gap", "issueType")).toEqual({ id: "33", name: "要望" });
  });

  it("英語名の Bug / Task にもマッチする", () => {
    const en: CatalogItem[] = [
      { id: "1", name: "Bug" },
      { id: "2", name: "Task" },
      { id: "3", name: "Story" },
    ];
    expect(pickByName(en, "bug", "issueType")?.id).toBe("1");
    expect(pickByName(en, "ux", "issueType")?.id).toBe("2");
    expect(pickByName(en, "feature-request", "issueType")?.id).toBe("3");
  });

  it("bug の優先度は 高、その他は 中", () => {
    expect(pickByName(PRIORITIES, "bug", "priority")).toEqual({ id: "2", name: "高" });
    expect(pickByName(PRIORITIES, "ux", "priority")).toEqual({ id: "3", name: "中" });
    expect(pickByName(PRIORITIES, "feature-request", "priority")).toEqual({ id: "3", name: "中" });
  });

  it("一致しなければ null", () => {
    expect(pickByName([{ id: "9", name: "調査" }], "bug", "issueType")).toBeNull();
  });
});

describe("pickCatalogItem", () => {
  it("名前が一致すればモデルを呼ばない", async () => {
    const pickWithModel = vi.fn();
    const picked = await pickCatalogItem({
      items: TYPES,
      category: "bug",
      kind: "issueType",
      pickWithModel,
    });
    expect(picked?.name).toBe("バグ");
    expect(pickWithModel).not.toHaveBeenCalled();
  });

  it("名前が一致しなければモデルに選ばせる", async () => {
    const custom: CatalogItem[] = [
      { id: "9", name: "調査" },
      { id: "8", name: "リリース" },
    ];
    const pickWithModel = vi.fn().mockResolvedValue(custom[0]);
    const picked = await pickCatalogItem({
      items: custom,
      category: "bug",
      kind: "issueType",
      pickWithModel,
    });
    expect(pickWithModel).toHaveBeenCalledWith(custom, "bug", "issueType");
    expect(picked?.name).toBe("調査");
  });

  it("モデルも決められなければ先頭アイテムにフォールバックする", async () => {
    const custom: CatalogItem[] = [
      { id: "9", name: "調査" },
      { id: "8", name: "リリース" },
    ];
    const picked = await pickCatalogItem({
      items: custom,
      category: "ux",
      kind: "issueType",
      pickWithModel: async () => null,
    });
    expect(picked?.name).toBe("調査");
  });

  it("空配列なら null", async () => {
    expect(await pickCatalogItem({
      items: [],
      category: "bug",
      kind: "priority",
      pickWithModel: async () => ({ id: "1", name: "x" }),
    })).toBeNull();
  });
});

describe("toCatalogItems", () => {
  it("id/name を文字列に正規化する", () => {
    expect(toCatalogItems([{ id: 1, name: "バグ" }, { id: "2", name: "タスク" }])).toEqual([
      { id: "1", name: "バグ" },
      { id: "2", name: "タスク" },
    ]);
  });

  it("配列でなければ空", () => {
    expect(toCatalogItems({ error: true })).toEqual([]);
    expect(toCatalogItems(null)).toEqual([]);
  });
});
