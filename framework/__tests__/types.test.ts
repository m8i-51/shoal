import { describe, it, expect } from "vitest";
import { isFinding } from "../types";

describe("isFinding", () => {
  it("id/category/timestamp が文字列なら true", () => {
    expect(isFinding({ id: "f1", category: "bug", timestamp: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("triage_result.json の形（id/category/timestamp を持たない）は false", () => {
    expect(isFinding({ runId: "run_1", completedAt: "x", issued: [], skipped: [], unprocessed: [] })).toBe(false);
  });

  it("null は false", () => {
    expect(isFinding(null)).toBe(false);
  });

  it("オブジェクトでない値（文字列・数値・配列）は false", () => {
    expect(isFinding("a string")).toBe(false);
    expect(isFinding(42)).toBe(false);
    expect(isFinding([])).toBe(false);
  });

  it("id が無いと false", () => {
    expect(isFinding({ category: "bug", timestamp: "x" })).toBe(false);
  });

  it("category が無いと false", () => {
    expect(isFinding({ id: "f1", timestamp: "x" })).toBe(false);
  });

  it("timestamp が無いと false", () => {
    expect(isFinding({ id: "f1", category: "bug" })).toBe(false);
  });

  it("category が数値など文字列以外だと false", () => {
    expect(isFinding({ id: "f1", category: 123, timestamp: "x" })).toBe(false);
  });
});
