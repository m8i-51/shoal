import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";
import {
  clickNameCandidates,
  extractAriaRef,
  bestAriaRefFromSnapshot,
  resolveClickLocator,
  clickDescribedElement,
  clickToolHasTarget,
} from "../click-target";

describe("clickNameCandidates", () => {
  it("長い説明から accessible name になりそうな短い候補を先に出す", () => {
    const names = clickNameCandidates("Close button (×) on the tutorial overlay");
    expect(names[0]).toBe("Close");
    expect(names).toContain("Close button");
    expect(names).toContain("Close button (×) on the tutorial overlay");
  });

  it("引用符で囲まれた名前を候補にする", () => {
    expect(clickNameCandidates('Click the "Save draft" button')).toContain("Save draft");
  });

  it("空文字は空配列", () => {
    expect(clickNameCandidates("")).toEqual([]);
    expect(clickNameCandidates("   ")).toEqual([]);
  });
});

describe("extractAriaRef", () => {
  it("スナップショット記法の ref を取り出す", () => {
    expect(extractAriaRef('button "Close" [ref=e12]')).toBe("e12");
    expect(extractAriaRef("ref=e3")).toBe("e3");
    expect(extractAriaRef("e12")).toBe("e12");
  });

  it("説明文だけなら ref ではない", () => {
    expect(extractAriaRef("Close button (×) on the tutorial overlay")).toBeUndefined();
    expect(extractAriaRef("Next")).toBeUndefined();
  });
});

describe("bestAriaRefFromSnapshot", () => {
  const snapshot = `
- heading "Tutorial" [ref=e1]
- generic [ref=e10]:
  - button "Close" [ref=e2]
  - button "Next" [ref=e3]
`;

  it("説明文に含まれる短い accessible name の ref を返す", () => {
    expect(bestAriaRefFromSnapshot(snapshot, "Close button (×) on the tutorial overlay")).toBe("e2");
  });

  it("一致が無ければ undefined", () => {
    expect(bestAriaRefFromSnapshot(snapshot, "Download invoice")).toBeUndefined();
  });
});

function emptyLocator() {
  const loc = {
    first: vi.fn(() => loc),
    count: vi.fn().mockResolvedValue(0),
    click: vi.fn().mockRejectedValue(new Error("not found")),
    innerText: vi.fn().mockRejectedValue(new Error("not found")),
    getAttribute: vi.fn().mockResolvedValue(null),
  };
  return loc;
}

function presentLocator() {
  const loc = {
    first: vi.fn(() => loc),
    count: vi.fn().mockResolvedValue(1),
    click: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn().mockResolvedValue("Close"),
    getAttribute: vi.fn().mockResolvedValue("Close"),
  };
  return loc;
}

describe("resolveClickLocator", () => {
  it("説明文全体ではなく名前の部分一致でボタンを見つける", async () => {
    const closeBtn = presentLocator();
    const empty = emptyLocator();
    const page = {
      getByRole: vi.fn((_role: string, opts?: { name?: string | RegExp }) => {
        if (opts?.name === "Close") return closeBtn;
        return empty;
      }),
      getByText: vi.fn(() => empty),
      locator: vi.fn(() => empty),
      ariaSnapshot: vi.fn().mockResolvedValue("- button \"Close\" [ref=e2]"),
    } as unknown as Page;

    const loc = await resolveClickLocator(page, {
      description: "Close button (×) on the tutorial overlay",
    });
    expect(loc).toBe(closeBtn);
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Close" });
  });

  it("ref だけでも対象を取る", async () => {
    const byRef = presentLocator();
    const empty = emptyLocator();
    const page = {
      getByRole: vi.fn(() => empty),
      getByText: vi.fn(() => empty),
      locator: vi.fn((sel: string) => (sel === "aria-ref=e12" ? byRef : empty)),
      ariaSnapshot: vi.fn(),
    } as unknown as Page;

    const loc = await resolveClickLocator(page, { ref: "e12" });
    expect(loc).toBe(byRef);
  });

  it("明示的な aria-ref でクリック対象を取る", async () => {
    const byRef = presentLocator();
    const empty = emptyLocator();
    const page = {
      getByRole: vi.fn(() => empty),
      getByText: vi.fn(() => empty),
      locator: vi.fn((sel: string) => (sel === "aria-ref=e2" ? byRef : empty)),
      ariaSnapshot: vi.fn(),
    } as unknown as Page;

    const loc = await resolveClickLocator(page, { description: "Close", ref: "e2" });
    expect(loc).toBe(byRef);
    expect(page.locator).toHaveBeenCalledWith("aria-ref=e2");
  });

  it("getByRole が外れたらスナップショットの ref にフォールバックする", async () => {
    const byRef = presentLocator();
    const empty = emptyLocator();
    const page = {
      getByRole: vi.fn(() => empty),
      getByText: vi.fn(() => empty),
      locator: vi.fn((sel: string) => (sel === "aria-ref=e2" ? byRef : empty)),
      ariaSnapshot: vi.fn().mockResolvedValue('- button "Close" [ref=e2]'),
    } as unknown as Page;

    const loc = await resolveClickLocator(page, {
      description: "Close button (×) on the tutorial overlay",
    });
    expect(loc).toBe(byRef);
    expect(page.ariaSnapshot).toHaveBeenCalled();
  });
});

describe("clickDescribedElement", () => {
  it("解決できた要素をクリックする", async () => {
    const closeBtn = presentLocator();
    const empty = emptyLocator();
    const page = {
      getByRole: vi.fn((_role: string, opts?: { name?: string | RegExp }) => {
        if (opts?.name === "Close") return closeBtn;
        return empty;
      }),
      getByText: vi.fn(() => empty),
      locator: vi.fn(() => empty),
      ariaSnapshot: vi.fn().mockResolvedValue(""),
    } as unknown as Page;

    await clickDescribedElement(page, { description: "Close button (×) on the tutorial overlay" });
    expect(closeBtn.click).toHaveBeenCalled();
  });

  it("対象が無ければエラーにする", async () => {
    const empty = emptyLocator();
    const page = {
      getByRole: vi.fn(() => empty),
      getByText: vi.fn(() => empty),
      locator: vi.fn(() => empty),
      ariaSnapshot: vi.fn().mockResolvedValue("- heading \"Home\" [ref=e1]"),
    } as unknown as Page;

    await expect(
      clickDescribedElement(page, { description: "Nonexistent control" }),
    ).rejects.toThrow(/No element matching/);
  });
});

describe("clickToolHasTarget", () => {
  it("accepts ref without description", () => {
    expect(clickToolHasTarget({ ref: "e12" })).toBe(true);
    expect(clickToolHasTarget({ description: "Log in" })).toBe(true);
    expect(clickToolHasTarget({ description: "  ", ref: "" })).toBe(false);
    expect(clickToolHasTarget({})).toBe(false);
  });
});
