import { describe, it, expect, vi, beforeEach } from "vitest";

const createMessage = vi.fn();
vi.mock("../../llm-client", () => ({
  createLLMClient: () => ({
    client: { createMessage },
    defaultModel: "test-model",
    provider: "anthropic",
  }),
}));

import { defaultPickWithModel } from "../catalog-pick";

describe("defaultPickWithModel", () => {
  beforeEach(() => {
    createMessage.mockReset();
  });

  it("モデルが返した id のアイテムを返す", async () => {
    createMessage.mockResolvedValue({
      content: [{ type: "text", text: "9" }],
    });
    const items = [
      { id: "8", name: "リリース" },
      { id: "9", name: "調査" },
    ];
    const picked = await defaultPickWithModel(items, "bug", "issueType");
    expect(picked?.name).toBe("調査");
    expect(createMessage).toHaveBeenCalled();
  });

  it("id= 付きの返答からも id を拾う", async () => {
    createMessage.mockResolvedValue({
      content: [{ type: "text", text: "id=8" }],
    });
    const items = [
      { id: "8", name: "リリース" },
      { id: "9", name: "調査" },
    ];
    expect((await defaultPickWithModel(items, "ux", "issueType"))?.id).toBe("8");
  });

  it("例外時は null", async () => {
    createMessage.mockRejectedValue(new Error("no key"));
    expect(await defaultPickWithModel([{ id: "1", name: "x" }], "bug", "priority")).toBeNull();
  });

  it("空配列なら null（モデルを呼ばない）", async () => {
    expect(await defaultPickWithModel([], "bug", "issueType")).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });
});
