import { describe, it, expect } from "vitest";
import { resolveIssueId, formatIssueRef } from "../issue-id";

const CLOSED = [
  { number: "PROJ-55", title: "Login bug" },
  { number: "PROJ-100", title: "Crash" },
  { number: 42, title: "GitHub issue" },
];

describe("resolveIssueId", () => {
  it("Backlog 形式の issue key をそのまま返す", () => {
    expect(resolveIssueId("PROJ-55", CLOSED)).toBe("PROJ-55");
  });

  it("Jira 形式の issue key をそのまま返す", () => {
    expect(resolveIssueId("ABC-123", CLOSED)).toBe("ABC-123");
  });

  it("数値のみの場合は closed issues から suffix で解決する", () => {
    expect(resolveIssueId("55", CLOSED)).toBe("PROJ-55");
    expect(resolveIssueId(55, CLOSED)).toBe("PROJ-55");
  });

  it("完全一致があればそれを返す", () => {
    expect(resolveIssueId("PROJ-100", CLOSED)).toBe("PROJ-100");
    expect(resolveIssueId(42, CLOSED)).toBe(42);
  });

  it("GitHub の数値 ID はそのまま数値で返す", () => {
    expect(resolveIssueId("42", CLOSED)).toBe(42);
  });

  it("解決できない数値はそのまま数値で返す", () => {
    expect(resolveIssueId("999", [])).toBe(999);
  });

  it("空文字列は空文字列のまま返す", () => {
    expect(resolveIssueId("", CLOSED)).toBe("");
  });
});

describe("formatIssueRef", () => {
  it("GitHub 数値 ID には # プレフィックスを付ける", () => {
    expect(formatIssueRef(42)).toBe("#42");
    expect(formatIssueRef("42")).toBe("#42");
  });

  it("Backlog/Jira issue key はそのまま表示する", () => {
    expect(formatIssueRef("PROJ-55")).toBe("PROJ-55");
    expect(formatIssueRef("ABC-123")).toBe("ABC-123");
  });
});
