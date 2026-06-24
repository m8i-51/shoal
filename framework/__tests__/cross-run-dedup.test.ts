import { describe, it, expect } from "vitest";
import { groupSimilarFindings, findCrossRunDuplicates } from "../cross-run-dedup";
import type { Finding } from "../types";

function mockFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_1",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Untitled",
    body: "",
    category: "bug",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("groupSimilarFindings", () => {
  it("空配列 → 空配列", () => {
    expect(groupSimilarFindings([])).toEqual([]);
  });

  it("似ていない finding は別クラスタになる", () => {
    const a = mockFinding({ id: "a", title: "Login button broken", body: "clicking login does nothing" });
    const b = mockFinding({ id: "b", title: "Dark mode toggle missing", body: "no way to switch themes" });
    const clusters = groupSimilarFindings([a, b]);
    expect(clusters).toHaveLength(2);
  });

  it("似ている finding は同じクラスタになる（run をまたいでも）", () => {
    const a = mockFinding({
      id: "a", runId: "run_1",
      title: "Dashboard metric not accessible via API",
      body: "The dashboard shows a metric card but there is no API endpoint to retrieve it.",
    });
    const b = mockFinding({
      id: "b", runId: "run_2",
      title: "Dashboard metrics not accessible via API",
      body: "The dashboard metric card has no corresponding API endpoint to retrieve it.",
    });
    const clusters = groupSimilarFindings([a, b]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it("3件中2件が似ている → 2クラスタ（似ているペア + 単独1件）", () => {
    const a = mockFinding({ id: "a", title: "Profile update API missing", body: "no endpoint to update profile" });
    const b = mockFinding({ id: "b", title: "Profile update API is missing", body: "no endpoint exists to update the profile" });
    const c = mockFinding({ id: "c", title: "Dark mode toggle missing", body: "no way to switch themes at all" });
    const clusters = groupSimilarFindings([a, b, c]);
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((cl) => cl.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it("threshold を下げるとより緩く同一クラスタになる", () => {
    const a = mockFinding({ id: "a", title: "Cannot export dashboard data", body: "no CSV export button" });
    const b = mockFinding({ id: "b", title: "Missing budgeting dashboard", body: "no way to adjust project budget" });
    const clustersStrict = groupSimilarFindings([a, b], 0.9);
    const clustersLoose = groupSimilarFindings([a, b], 0.01);
    expect(clustersStrict).toHaveLength(2);
    expect(clustersLoose).toHaveLength(1);
  });
});

describe("findCrossRunDuplicates", () => {
  it("単独 finding しかない場合は空配列", () => {
    const a = mockFinding({ id: "a", title: "Login button broken", body: "clicking login does nothing" });
    const b = mockFinding({ id: "b", title: "Dark mode toggle missing", body: "no way to switch themes" });
    expect(findCrossRunDuplicates([a, b])).toEqual([]);
  });

  it("2件以上のクラスタのみ返す", () => {
    const a = mockFinding({ id: "a", runId: "run_1", title: "Dashboard metric not accessible via API", body: "no endpoint for the metric card" });
    const b = mockFinding({ id: "b", runId: "run_2", title: "Dashboard metrics not accessible via API", body: "no endpoint for the metric card" });
    const c = mockFinding({ id: "c", runId: "run_3", title: "Dark mode toggle missing", body: "no way to switch themes" });
    const result = findCrossRunDuplicates([a, b, c]);
    expect(result).toHaveLength(1);
    expect(result[0].map((f) => f.runId).sort()).toEqual(["run_1", "run_2"]);
  });
});
