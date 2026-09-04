import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pruneRunArtifacts, getRetentionDays, DEFAULT_RETENTION_DAYS } from "../retention";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("getRetentionDays", () => {
  it("未設定ならデフォルト30日を返す（警告なし）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRetentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("SHOAL_RETENTION_DAYS を数値として読む", () => {
    expect(getRetentionDays({ SHOAL_RETENTION_DAYS: "7" })).toBe(7);
  });

  it("0（保持なし＝プルーニング無効）は正規の値として警告なしで受け入れる", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRetentionDays({ SHOAL_RETENTION_DAYS: "0" })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("不正な値はデフォルトにフォールバックしつつ警告する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRetentionDays({ SHOAL_RETENTION_DAYS: "not-a-number" })).toBe(DEFAULT_RETENTION_DAYS);
    expect(getRetentionDays({ SHOAL_RETENTION_DAYS: "-5" })).toBe(DEFAULT_RETENTION_DAYS);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("SHOAL_RETENTION_DAYS");
    warn.mockRestore();
  });
});

describe("pruneRunArtifacts", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "retention-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function makeRunDir(base: string, runId: string): string {
    const dir = path.join(cwd, "logs", base, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dummy.txt"), "x");
    return dir;
  }

  it("retentionDays より古い run ディレクトリを削除する", () => {
    const now = Date.now();
    const old = makeRunDir("screenshots", `run_${now - 40 * DAY_MS}`);
    const recent = makeRunDir("screenshots", `run_${now - 5 * DAY_MS}`);

    const removed = pruneRunArtifacts(cwd, 30, now);

    expect(removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("screenshots と traces の両方を対象にする", () => {
    const now = Date.now();
    const oldScreenshot = makeRunDir("screenshots", `run_${now - 40 * DAY_MS}`);
    const oldTrace = makeRunDir("traces", `run_${now - 40 * DAY_MS}`);

    const removed = pruneRunArtifacts(cwd, 30, now);

    expect(removed).toBe(2);
    expect(fs.existsSync(oldScreenshot)).toBe(false);
    expect(fs.existsSync(oldTrace)).toBe(false);
  });

  it("retentionDays が 0 なら何も削除しない", () => {
    const now = Date.now();
    const old = makeRunDir("screenshots", `run_${now - 400 * DAY_MS}`);

    const removed = pruneRunArtifacts(cwd, 0, now);

    expect(removed).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });

  it("run_ 形式でないディレクトリ名は無視する", () => {
    const now = Date.now();
    const other = path.join(cwd, "logs", "screenshots", "not-a-run-dir");
    fs.mkdirSync(other, { recursive: true });

    const removed = pruneRunArtifacts(cwd, 30, now);

    expect(removed).toBe(0);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("logs ディレクトリが存在しなくてもエラーにならない", () => {
    expect(pruneRunArtifacts(cwd, 30)).toBe(0);
  });
});
