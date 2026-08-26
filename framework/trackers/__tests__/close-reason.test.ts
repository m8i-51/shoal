import { describe, it, expect } from "vitest";
import { normalizeCloseReason } from "../close-reason";

describe("normalizeCloseReason", () => {
  it("won't fix / not planned を not_planned に正規化する", () => {
    expect(normalizeCloseReason({ resolutionName: "Won't Fix" })).toBe("not_planned");
    expect(normalizeCloseReason({ statusName: "Not planned" })).toBe("not_planned");
    expect(normalizeCloseReason({ labels: ["wontfix"] })).toBe("not_planned");
    expect(normalizeCloseReason({ statusName: "不対応" })).toBe("not_planned");
  });

  it("通常の close は completed に正規化する", () => {
    expect(normalizeCloseReason({ resolutionName: "Done" })).toBe("completed");
    expect(normalizeCloseReason({ statusName: "Closed" })).toBe("completed");
  });

  it("判定材料がなければ null", () => {
    expect(normalizeCloseReason({})).toBeNull();
    expect(normalizeCloseReason({ resolutionName: "  " })).toBeNull();
  });
});
