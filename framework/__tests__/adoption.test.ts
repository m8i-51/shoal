import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

import { recordIssueLink, updateAdoption, formatAdoptionSummary, loadIssueLinks, type IssueLink } from "../adoption";
import type { ClosedIssue } from "../trackers/index";

function makeLink(overrides: Partial<IssueLink> = {}): IssueLink {
  return {
    url: "https://github.com/o/r/issues/12",
    title: "[bug] Login broken",
    category: "bug",
    lenses: ["Security"],
    scenarios: [],
    runId: "run_1",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeClosed(overrides: Partial<ClosedIssue> = {}): ClosedIssue {
  return {
    number: 12,
    title: "[bug] Login broken",
    body: "",
    labels: ["bug", "feedback-agent"],
    url: "https://github.com/o/r/issues/12",
    stateReason: "completed",
    ...overrides,
  };
}

// files キー（cwd からの相対パス）で読み書きをキャプチャする簡易 fs モック
const KNOWN_FILES = ["coverage/issue-links.json", "coverage/adoption.json"];

function setupFs(initial: Record<string, unknown>) {
  const files = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const keyFor = (p: unknown) => KNOWN_FILES.find((k) => String(p).endsWith(k));
  vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
    const key = keyFor(p);
    return key != null && files.has(key);
  });
  vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => files.get(keyFor(p) ?? "") ?? "") as typeof fs.readFileSync);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockImplementation(((p: unknown, content: unknown) => {
    const key = keyFor(p);
    if (key) files.set(key, String(content));
  }) as typeof fs.writeFileSync);
  return files;
}

const LINKS = "coverage/issue-links.json";
const ADOPTION = "coverage/adoption.json";

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(fs.writeFileSync).mockReset();
});

describe("recordIssueLink", () => {
  it("リンクを issue-links.json に追記する", () => {
    const files = setupFs({ [LINKS]: [makeLink({ url: "https://github.com/o/r/issues/1" })] });
    recordIssueLink(makeLink({ url: "https://github.com/o/r/issues/2" }));
    const saved = JSON.parse(files.get(LINKS)!) as IssueLink[];
    expect(saved).toHaveLength(2);
    expect(saved[1].url).toBe("https://github.com/o/r/issues/2");
  });
});

describe("updateAdoption", () => {
  it("completed で close された issue を adopted として集計しリンクを解決済みにする", () => {
    const files = setupFs({ [LINKS]: [makeLink()] });
    updateAdoption([makeClosed({ stateReason: "completed" })]);

    const links = JSON.parse(files.get(LINKS)!) as IssueLink[];
    expect(links[0].resolution).toBe("adopted");

    const stats = JSON.parse(files.get(ADOPTION)!);
    expect(stats.byLens["Security"]).toEqual({ adopted: 1, rejected: 0 });
    expect(stats.byCategory["bug"]).toEqual({ adopted: 1, rejected: 0 });
  });

  it("not_planned で close された issue は rejected として集計する", () => {
    const files = setupFs({ [LINKS]: [makeLink()] });
    updateAdoption([makeClosed({ stateReason: "not_planned" })]);
    const stats = JSON.parse(files.get(ADOPTION)!);
    expect(stats.byLens["Security"]).toEqual({ adopted: 0, rejected: 1 });
  });

  it("stateReason のないトラッカー（Jira 等）の close は adopted 扱いにする", () => {
    const files = setupFs({ [LINKS]: [makeLink({ url: "" })] });
    updateAdoption([makeClosed({ url: undefined, stateReason: undefined })]);
    const stats = JSON.parse(files.get(ADOPTION)!);
    expect(stats.byLens["Security"].adopted).toBe(1);
  });

  it("URL がなくてもタイトル一致で突合できる", () => {
    const files = setupFs({ [LINKS]: [makeLink({ url: "" })] });
    updateAdoption([makeClosed({ url: undefined, number: 99 })]);
    const links = JSON.parse(files.get(LINKS)!) as IssueLink[];
    expect(links[0].resolution).toBe("adopted");
  });

  it("解決済みリンクは再集計しない", () => {
    const files = setupFs({
      [LINKS]: [makeLink({ resolution: "adopted", resolvedAt: "2026-06-02T00:00:00.000Z" })],
      [ADOPTION]: { byLens: { Security: { adopted: 1, rejected: 0 } }, byCategory: { bug: { adopted: 1, rejected: 0 } } },
    });
    updateAdoption([makeClosed()]);
    const stats = JSON.parse(files.get(ADOPTION)!);
    expect(stats.byLens["Security"].adopted).toBe(1); // 増えない
  });

  it("close されていないリンクは未解決のまま残る", () => {
    const files = setupFs({ [LINKS]: [makeLink()] });
    updateAdoption([]); // closed issue なし
    // 書き込みは発生しない
    expect(files.get(ADOPTION)).toBeUndefined();
    const links = JSON.parse(files.get(LINKS)!) as IssueLink[];
    expect(links[0].resolution).toBeUndefined();
  });

  it("集計サマリーを返す", () => {
    setupFs({ [LINKS]: [makeLink()] });
    const summary = updateAdoption([makeClosed()]);
    expect(summary).toContain("Finding adoption");
    expect(summary).toContain("Security: 1 adopted / 0 rejected (100%)");
  });
});

describe("formatAdoptionSummary", () => {
  it("データがなければ空文字を返す", () => {
    setupFs({});
    expect(formatAdoptionSummary()).toBe("");
  });

  it("lens とカテゴリの採用率をまとめる", () => {
    const summary = formatAdoptionSummary({
      byLens: { Security: { adopted: 3, rejected: 1 }, Accessibility: { adopted: 0, rejected: 2 } },
      byCategory: { bug: { adopted: 3, rejected: 0 } },
    });
    expect(summary).toContain("Security: 3 adopted / 1 rejected (75%)");
    expect(summary).toContain("Accessibility: 0 adopted / 2 rejected (0%)");
    expect(summary).toContain("bug: 3 adopted / 0 rejected (100%)");
    expect(summary).toContain("reduce — don't eliminate");
  });
});

describe("loadIssueLinks", () => {
  it("ファイルがなければ空配列", () => {
    setupFs({});
    expect(loadIssueLinks()).toEqual([]);
  });
});
