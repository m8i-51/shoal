import { describe, it, expect, vi } from "vitest";
import type { BrowserContext, Route, Request } from "playwright";

import {
  getShoalMode,
  shouldBlockRequest,
  applyBrowserGuardrails,
  filterAppTools,
  guardrailPrompt,
  isDestructiveBrowserAction,
  guardSafeBrowserClick,
  type AppTool,
} from "../guardrails";
import type { Page } from "playwright";

describe("getShoalMode", () => {
  it("デフォルトは safe", () => {
    expect(getShoalMode({})).toBe("safe");
  });

  it("有効な値をそのまま返す（大文字・空白は正規化）", () => {
    expect(getShoalMode({ SHOAL_MODE: "read-only" })).toBe("read-only");
    expect(getShoalMode({ SHOAL_MODE: " FULL " })).toBe("full");
    expect(getShoalMode({ SHOAL_MODE: "Safe" })).toBe("safe");
  });

  it("不正な値は safe にフォールバックする", () => {
    expect(getShoalMode({ SHOAL_MODE: "yolo" })).toBe("safe");
  });
});

describe("shouldBlockRequest", () => {
  it("read-only では mutation メソッドをブロックする", () => {
    expect(shouldBlockRequest("POST", "read-only")).toBe(true);
    expect(shouldBlockRequest("put", "read-only")).toBe(true);
    expect(shouldBlockRequest("PATCH", "read-only")).toBe(true);
    expect(shouldBlockRequest("DELETE", "read-only")).toBe(true);
  });

  it("read-only でも GET/HEAD は通す", () => {
    expect(shouldBlockRequest("GET", "read-only")).toBe(false);
    expect(shouldBlockRequest("HEAD", "read-only")).toBe(false);
  });

  it("safe では DELETE のみブロックする", () => {
    expect(shouldBlockRequest("DELETE", "safe")).toBe(true);
    expect(shouldBlockRequest("POST", "safe")).toBe(false);
    expect(shouldBlockRequest("PATCH", "safe")).toBe(false);
  });

  it("safe / full では POST/PUT/PATCH は通す", () => {
    expect(shouldBlockRequest("POST", "safe")).toBe(false);
    expect(shouldBlockRequest("DELETE", "full")).toBe(false);
  });
});

describe("applyBrowserGuardrails", () => {
  function makeContext(): { context: BrowserContext; getHandler: () => (route: Route) => unknown } {
    let handler: ((route: Route) => unknown) | null = null;
    const context = {
      route: vi.fn(async (_pattern: string, h: (route: Route) => unknown) => {
        handler = h;
      }),
    } as unknown as BrowserContext;
    return { context, getHandler: () => handler! };
  }

  function makeRoute(method: string): { route: Route; abort: ReturnType<typeof vi.fn>; continue: ReturnType<typeof vi.fn> } {
    const abort = vi.fn();
    const cont = vi.fn();
    const route = {
      request: () => ({ method: () => method, url: () => "http://localhost/api/items" }) as unknown as Request,
      abort,
      continue: cont,
    } as unknown as Route;
    return { route, abort, continue: cont };
  }

  it("safe でも DELETE を abort する", async () => {
    const { context, getHandler } = makeContext();
    await applyBrowserGuardrails(context, "safe");
    expect(vi.mocked(context.route)).toHaveBeenCalledTimes(1);

    const del = makeRoute("DELETE");
    await getHandler()(del.route);
    expect(del.abort).toHaveBeenCalledWith("accessdenied");
  });

  it("full では route を登録しない", async () => {
    const { context } = makeContext();
    await applyBrowserGuardrails(context, "full");
    expect(vi.mocked(context.route)).not.toHaveBeenCalled();
  });

  it("read-only では mutation を abort し GET は continue する", async () => {
    const { context, getHandler } = makeContext();
    await applyBrowserGuardrails(context, "read-only");
    expect(vi.mocked(context.route)).toHaveBeenCalledTimes(1);

    const post = makeRoute("POST");
    await getHandler()(post.route);
    expect(post.abort).toHaveBeenCalledWith("accessdenied");
    expect(post.continue).not.toHaveBeenCalled();

    const get = makeRoute("GET");
    await getHandler()(get.route);
    expect(get.continue).toHaveBeenCalled();
    expect(get.abort).not.toHaveBeenCalled();
  });
});

describe("filterAppTools", () => {
  const tools: AppTool[] = [
    { name: "list_items", description: "list", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "delete_item", description: "delete", input_schema: { type: "object", properties: {}, required: [] }, destructive: true },
  ];

  it("full では全ツールを返す", () => {
    const result = filterAppTools(tools, "full");
    expect(result.map((t) => t.name)).toEqual(["list_items", "delete_item"]);
  });

  it("safe / read-only では destructive ツールを除外する", () => {
    expect(filterAppTools(tools, "safe").map((t) => t.name)).toEqual(["list_items"]);
    expect(filterAppTools(tools, "read-only").map((t) => t.name)).toEqual(["list_items"]);
  });

  it("LLM API に渡せるよう destructive フラグを取り除く", () => {
    for (const tool of filterAppTools(tools, "full")) {
      expect("destructive" in tool).toBe(false);
    }
  });
});

describe("guardrailPrompt", () => {
  it("read-only / safe は指示を返し、full は空文字を返す", () => {
    expect(guardrailPrompt("read-only")).toContain("READ-ONLY");
    expect(guardrailPrompt("safe")).toContain("SAFE");
    expect(guardrailPrompt("safe")).toContain("blocked programmatically");
    expect(guardrailPrompt("full")).toBe("");
  });
});

describe("isDestructiveBrowserAction", () => {
  it("削除・支払い・送信系の文言を検出する", () => {
    expect(isDestructiveBrowserAction("Delete account")).toBe(true);
    expect(isDestructiveBrowserAction("Pay now")).toBe(true);
    expect(isDestructiveBrowserAction("Send invitation")).toBe(true);
    expect(isDestructiveBrowserAction("Save changes")).toBe(false);
  });
});

describe("guardSafeBrowserClick", () => {
  function makePage(buttonText: string): Page {
    const button = {
      count: vi.fn(async () => 1),
      innerText: vi.fn(async () => buttonText),
      getAttribute: vi.fn(async () => null),
    };
    return {
      getByRole: vi.fn(() => ({ first: () => button })),
      getByText: vi.fn(() => ({ first: () => button })),
    } as unknown as Page;
  }

  it("full モードでは常に許可する", async () => {
    const result = await guardSafeBrowserClick(makePage("Delete"), "Delete item", "full");
    expect(result.allowed).toBe(true);
  });

  it("safe モードで destructive なクリックをブロックする", async () => {
    const result = await guardSafeBrowserClick(makePage("Delete permanently"), "Delete item", "safe");
    expect(result.allowed).toBe(false);
    expect(result.message).toContain("Blocked click");
  });

  it("safe モードでも無害なクリックは許可する", async () => {
    const result = await guardSafeBrowserClick(makePage("Continue"), "Continue", "safe");
    expect(result.allowed).toBe(true);
  });
});
