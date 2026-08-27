import { describe, it, expect } from "vitest";
import {
  normalizeThresholdCandidates,
  sortThresholdCandidates,
  assignThresholdCandidates,
  type ThresholdCandidate,
} from "../threshold";

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

describe("assignThresholdCandidates", () => {
  it("agentCount<=0 は空", () => {
    expect(assignThresholdCandidates([cand({ id: "a" })], 0)).toEqual([]);
    expect(assignThresholdCandidates([cand({ id: "a" })], -1)).toEqual([]);
  });

  it("優先順にラウンドロビンし同一 area の重複を避ける", () => {
    const candidates = sortThresholdCandidates([
      cand({ id: "b-a", kind: "business", area: "/billing", priority: 1 }),
      cand({ id: "i-a", kind: "input", area: "/billing", priority: 1 }),
      cand({ id: "b-b", kind: "business", area: "/team", priority: 1 }),
      cand({ id: "e-c", kind: "experience", area: "/reports", priority: 2 }),
    ]);
    const assigned = assignThresholdCandidates(candidates, 2);
    expect(assigned).toHaveLength(2);
    expect(assigned[0].map((c) => c.id)).toContain("b-a");
    expect(assigned[1].map((c) => c.id)).toContain("b-b");
    // /billing は agent0 に既にあるので i-a は別 agent か後回しで同一 agent に重ねない
    const areas0 = new Set(assigned[0].map((c) => c.area));
    const areas1 = new Set(assigned[1].map((c) => c.area));
    expect(areas0.size).toBe(assigned[0].length);
    expect(areas1.size).toBe(assigned[1].length);
    const allIds = assigned.flat().map((c) => c.id);
    expect(allIds).toEqual(expect.arrayContaining(["b-a", "b-b", "i-a", "e-c"]));
    expect(allIds).toHaveLength(4);
  });

  it("候補が agent 数より少ないとき余った agent は空配列", () => {
    const assigned = assignThresholdCandidates([cand({ id: "only", area: "/one" })], 3);
    expect(assigned).toHaveLength(3);
    expect(assigned[0]).toHaveLength(1);
    expect(assigned[1]).toEqual([]);
    expect(assigned[2]).toEqual([]);
  });
});
