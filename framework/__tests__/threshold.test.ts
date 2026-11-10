import { describe, it, expect } from "vitest";
import {
  normalizeThresholdCandidates,
  sortThresholdCandidates,
  boundaryVisitAreas,
  formatBoundaryAreaHint,
  type ThresholdCandidate,
} from "../threshold";
import { makeBoundaryPushingAgent } from "../roster";

function cand(overrides: Partial<ThresholdCandidate> & Pick<ThresholdCandidate, "id">): ThresholdCandidate {
  return {
    kind: "input",
    area: "/form",
    signal: "max length",
    howToProbe: "type a long string",
    priority: 2,
    ...overrides,
  };
}

describe("normalizeThresholdCandidates", () => {
  it("null / undefined / 非配列は空配列", () => {
    expect(normalizeThresholdCandidates(undefined)).toEqual([]);
    expect(normalizeThresholdCandidates(null)).toEqual([]);
    expect(normalizeThresholdCandidates("x")).toEqual([]);
    expect(normalizeThresholdCandidates(42)).toEqual([]);
  });

  it("必須フィールド欠落や不正 kind は落とす", () => {
    const raw = [
      { id: "a", kind: "input", area: "/a", signal: "s", howToProbe: "h", priority: 1 },
      { id: "b", kind: "nope", area: "/b", signal: "s", howToProbe: "h", priority: 1 },
      { kind: "input", area: "/c", signal: "s", howToProbe: "h", priority: 1 },
      { id: "d", kind: "business", area: "", signal: "s", howToProbe: "h", priority: 1 },
      { id: "e", kind: "experience", area: "/e", signal: "s", howToProbe: "h", priority: 9 },
    ];
    const got = normalizeThresholdCandidates(raw);
    expect(got.map((c) => c.id)).toEqual(["a"]);
  });

  it("priority を 1|2|3 にクランプし expectedBehavior を残す", () => {
    const got = normalizeThresholdCandidates([
      { id: "x", kind: "Business", area: "/x", signal: "quota", howToProbe: "add seats", priority: "1", expectedBehavior: "show upgrade" },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: "x",
      kind: "business",
      priority: 1,
      expectedBehavior: "show upgrade",
    });
  });
});

describe("sortThresholdCandidates", () => {
  it("priority 昇順、同 rank なら business → input → experience", () => {
    const sorted = sortThresholdCandidates([
      cand({ id: "e2", kind: "experience", priority: 2 }),
      cand({ id: "i1", kind: "input", priority: 1 }),
      cand({ id: "b2", kind: "business", priority: 2 }),
      cand({ id: "i2", kind: "input", priority: 2 }),
      cand({ id: "b1", kind: "business", priority: 1 }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["b1", "i1", "b2", "i2", "e2"]);
  });
});

describe("boundaryVisitAreas", () => {
  it("優先順に area を並べ、同じ area は一度だけ", () => {
    const areas = boundaryVisitAreas([
      cand({ id: "e2", kind: "experience", area: "/reports", priority: 2, signal: "SECRET_SIGNAL", howToProbe: "SECRET_PROBE" }),
      cand({ id: "i1", kind: "input", area: "/form", priority: 1 }),
      cand({ id: "b1", kind: "business", area: "/billing", priority: 1, signal: "seat cap", howToProbe: "add one more seat" }),
      cand({ id: "i-bill", kind: "input", area: "/billing", priority: 2 }),
    ]);
    expect(areas).toEqual(["/billing", "/form", "/reports"]);
  });

  it("候補が空ならヒントも空", () => {
    expect(boundaryVisitAreas([])).toEqual([]);
    expect(formatBoundaryAreaHint("Ren", [])).toBe("");
  });
});

describe("formatBoundaryAreaHint", () => {
  it("area だけを最初に見る場所として渡し、signal と howToProbe は指示にしない", () => {
    const person = makeBoundaryPushingAgent();
    const areas = boundaryVisitAreas([
      cand({
        id: "b1",
        kind: "business",
        area: "/billing",
        priority: 1,
        signal: "SECRET_SIGNAL_DO_NOT_LEAK",
        howToProbe: "SECRET_PROBE_DO_NOT_LEAK",
      }),
      cand({ id: "i1", kind: "input", area: "/form", priority: 2, signal: "maxlength 40", howToProbe: "paste 40 chars" }),
    ]);
    const hint = formatBoundaryAreaHint(person.name, areas);
    expect(hint).toContain("[Where Ren looks first]");
    expect(hint).toContain("- /billing");
    expect(hint).toContain("- /form");
    expect(hint.indexOf("/billing")).toBeLessThan(hint.indexOf("/form"));
    expect(hint).toContain("post_feedback");
    expect(hint).toContain("I …");
    expect(hint).not.toContain("SECRET_SIGNAL_DO_NOT_LEAK");
    expect(hint).not.toContain("SECRET_PROBE_DO_NOT_LEAK");
    expect(hint).not.toContain("maxlength 40");
    expect(hint).not.toContain("paste 40 chars");
    expect(hint).not.toMatch(/howToProbe|threshold agent/i);
  });
});
