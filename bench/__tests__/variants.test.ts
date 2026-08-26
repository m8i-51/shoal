import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveBenchVariant, labelsPathForVariant, BENCH_VARIANTS } from "../variants";
import { loadLabels, recordBenchScore, loadPublishedScores, formatPublishedScoresMarkdown } from "../score";

describe("bench variants", () => {
  it("store と forms の 2 バリアントを解決できる", () => {
    expect(resolveBenchVariant("store").id).toBe("store");
    expect(resolveBenchVariant("forms").id).toBe("forms");
    expect(Object.keys(BENCH_VARIANTS)).toEqual(["store", "forms"]);
  });

  it("未知の BENCH_VARIANT はエラー", () => {
    expect(() => resolveBenchVariant("unknown")).toThrow(/Unknown BENCH_VARIANT/);
  });

  it("各バリアントの labels ファイルを読み込める", () => {
    for (const variant of Object.values(BENCH_VARIANTS)) {
      const labels = loadLabels(labelsPathForVariant(variant));
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.lens).toBeTruthy();
        expect(label.path).toBeTruthy();
      }
    }
  });
});

describe("published bench scores", () => {
  it("recordBenchScore で scores.json に追記できる", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scores-"));
    const scoresPath = path.join(dir, "scores.json");
    recordBenchScore({
      variant: "store",
      model: "test-model",
      detectionRate: 57,
      totalFindings: 8,
      runDate: "2026-08-26",
      config: "MAX_BROWSERS=2",
    }, scoresPath);
    const loaded = loadPublishedScores(scoresPath);
    expect(loaded.entries[0]).toMatchObject({ variant: "store", model: "test-model", detectionRate: 57 });
    const md = formatPublishedScoresMarkdown(loaded);
    expect(md).toContain("| store | test-model | 57% |");
  });
});
