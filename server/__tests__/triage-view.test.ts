import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { buildTriageView } from "../triage-view.js";

const tmpRoot = path.join(os.tmpdir(), `triage-view-test-${Date.now()}`);
const prevCwd = process.cwd();

function findingsDir(runId: string): string {
  return path.join(tmpRoot, "findings", runId);
}

function writeFinding(runId: string, finding: Record<string, unknown>): void {
  const dir = findingsDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${finding.id}.json`), JSON.stringify(finding), "utf-8");
}

function makeFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1",
    runId: "run_1",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Login is broken",
    body: "details",
    category: "bug",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeTriageResult(runId: string, result: Record<string, unknown>): void {
  const dir = findingsDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "triage_result.json"), JSON.stringify(result), "utf-8");
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildTriageView", () => {
  it("triage を通っていない run は null", () => {
    writeFinding("run_1", makeFinding());
    expect(buildTriageView("run_1")).toBeNull();
  });

  it("findings ディレクトリ自体が無ければ null", () => {
    expect(buildTriageView("run_404")).toBeNull();
  });

  it("run id の形式が不正なら null（パス脱出を試すものも含む）", () => {
    writeTriageResult("run_1", { runId: "run_1", issued: [], skipped: [], unprocessed: [] });
    expect(buildTriageView("../findings/run_1")).toBeNull();
    expect(buildTriageView("run_1/../run_1")).toBeNull();
    expect(buildTriageView("etc")).toBeNull();
  });

  it("壊れた triage_result.json は null（500 ではなく無扱い）", () => {
    const dir = findingsDir("run_1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "triage_result.json"), "{ not json", "utf-8");
    expect(buildTriageView("run_1")).toBeNull();
  });

  it("マージされた finding を ID ではなくタイトルで返す", () => {
    writeFinding("run_1", makeFinding({ id: "f1", title: "Login is broken", agentName: "Alice" }));
    writeFinding("run_1", makeFinding({ id: "f2", title: "Login 500s on submit", agentName: "Bob" }));
    writeTriageResult("run_1", {
      runId: "run_1",
      completedAt: "2026-01-02T00:00:00.000Z",
      issued: ["f1", "f2"],
      skipped: [],
      unprocessed: [],
      edgeRisks: [],
      issues: [{
        title: "[bug] Login broken",
        category: "bug",
        url: "https://example.com/issues/7",
        mergedFindingIds: ["f1", "f2"],
        edgeRisk: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      }],
      skips: [],
    });

    const view = buildTriageView("run_1")!;
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0].url).toBe("https://example.com/issues/7");
    expect(view.issues[0].mergedFindings.map((f) => f.title)).toEqual([
      "Login is broken",
      "Login 500s on submit",
    ]);
    expect(view.issues[0].mergedFindings.map((f) => f.agentName)).toEqual(["Alice", "Bob"]);
    expect(view.stats).toEqual({
      issuesCreated: 1,
      findingsIssued: 2,
      findingsSkipped: 0,
      findingsUnprocessed: 0,
      edgeRisks: 0,
    });
    expect(view.legacy).toBe(false);
  });

  it("edge-risk の尖りと理由をそのまま返す", () => {
    writeFinding("run_1", makeFinding({ id: "f1", category: "ux" }));
    writeTriageResult("run_1", {
      runId: "run_1",
      issued: ["f1"], skipped: [], unprocessed: [], edgeRisks: ["f1"],
      issues: [{
        title: "[ux] Add a mouse path",
        category: "ux",
        url: null,
        mergedFindingIds: ["f1"],
        edgeRisk: { edge: "Keyboard-only", why: "Mouse affordances blunt it" },
        createdAt: "2026-01-02T00:00:00.000Z",
      }],
      skips: [],
    });

    const view = buildTriageView("run_1")!;
    expect(view.issues[0].edgeRisk).toEqual({ edge: "Keyboard-only", why: "Mouse affordances blunt it" });
    expect(view.issues[0].url).toBeNull();
    expect(view.stats.edgeRisks).toBe(1);
  });

  it("edge / why が欠けた edge_risk は無視する", () => {
    writeFinding("run_1", makeFinding());
    writeTriageResult("run_1", {
      runId: "run_1", issued: ["f1"], skipped: [], unprocessed: [], edgeRisks: [],
      issues: [{
        title: "[ux] x", category: "ux", url: null, mergedFindingIds: ["f1"],
        edgeRisk: { edge: "Keyboard-only" }, createdAt: null,
      }],
      skips: [],
    });
    expect(buildTriageView("run_1")!.issues[0].edgeRisk).toBeNull();
  });

  it("skip は理由付きで、unprocessed はタイトル付きで返す", () => {
    writeFinding("run_1", makeFinding({ id: "f1", title: "Dup of an open issue" }));
    writeFinding("run_1", makeFinding({ id: "f2", title: "Never got triaged" }));
    writeTriageResult("run_1", {
      runId: "run_1",
      issued: [], skipped: ["f1"], unprocessed: ["f2"], edgeRisks: [],
      issues: [],
      skips: [{ findingId: "f1", reason: "duplicate of #3" }],
    });

    const view = buildTriageView("run_1")!;
    expect(view.skips).toEqual([
      { id: "f1", title: "Dup of an open issue", agentName: "Alice", category: "bug", reason: "duplicate of #3" },
    ]);
    expect(view.unprocessed).toEqual([
      { id: "f2", title: "Never got triaged", agentName: "Alice", category: "bug" },
    ]);
  });

  it("finding ファイルが消えていても ID だけで壊れずに返す", () => {
    writeTriageResult("run_1", {
      runId: "run_1", issued: ["gone"], skipped: [], unprocessed: [], edgeRisks: [],
      issues: [{ title: "[bug] x", category: "bug", url: null, mergedFindingIds: ["gone"], edgeRisk: null, createdAt: null }],
      skips: [],
    });
    const view = buildTriageView("run_1")!;
    expect(view.issues[0].mergedFindings).toEqual([
      { id: "gone", title: null, agentName: null, category: null },
    ]);
  });

  it("issues を持たない旧形式は legacy として読める", () => {
    writeFinding("run_1", makeFinding());
    writeTriageResult("run_1", {
      runId: "run_1",
      completedAt: "2026-01-02T00:00:00.000Z",
      issued: ["f1"],
      skipped: [],
      unprocessed: [],
      edgeRisks: [],
    });

    const view = buildTriageView("run_1")!;
    expect(view.legacy).toBe(true);
    expect(view.issues).toEqual([]);
    expect(view.stats.findingsIssued).toBe(1);
    expect(view.stats.issuesCreated).toBe(0);
  });

  it("何も起票していない新形式は legacy ではない", () => {
    writeFinding("run_1", makeFinding());
    writeTriageResult("run_1", {
      runId: "run_1", issued: [], skipped: ["f1"], unprocessed: [], edgeRisks: [],
      issues: [], skips: [{ findingId: "f1", reason: "not valuable" }],
    });
    expect(buildTriageView("run_1")!.legacy).toBe(false);
  });
});
