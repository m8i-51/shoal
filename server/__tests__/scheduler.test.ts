import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});
vi.mock("../runner.js", () => ({ spawnRun: vi.fn(), hasActiveRun: vi.fn().mockReturnValue(false) }));

import { loadSchedule, saveSchedule, type ScheduleConfig } from "../scheduler";
import { spawnRun, hasActiveRun } from "../runner.js";

const DEFAULT: ScheduleConfig = {
  enabled: false,
  dayOfWeek: 1,
  hour: 9,
  minute: 0,
  lastRunDate: null,
  pendingDate: null,
};

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue("{}");
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(hasActiveRun).mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadSchedule", () => {
  it("ファイルがない場合はデフォルト設定を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadSchedule()).toEqual(DEFAULT);
  });

  it("ファイルがある場合は設定を読み込む", () => {
    const saved: ScheduleConfig = { enabled: true, dayOfWeek: 3, hour: 14, minute: 30, lastRunDate: "2026-05-12", pendingDate: null };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(saved));
    expect(loadSchedule()).toEqual(saved);
  });

  it("ファイルが壊れている場合はデフォルトを返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid json{{{");
    expect(loadSchedule()).toEqual(DEFAULT);
  });

  it("pendingDate の無い古い schedule.json は null で埋める", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      enabled: true, dayOfWeek: 3, hour: 14, minute: 30, lastRunDate: "2026-05-12",
    }));
    expect(loadSchedule()).toEqual({
      enabled: true, dayOfWeek: 3, hour: 14, minute: 30, lastRunDate: "2026-05-12", pendingDate: null,
    });
  });

  it("部分的な設定はデフォルトとマージされる", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
    expect(loadSchedule()).toEqual({ ...DEFAULT, enabled: true });
  });
});

describe("saveSchedule", () => {
  it("設定を JSON ファイルに書き出す", () => {
    const config: ScheduleConfig = { enabled: true, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: null };
    saveSchedule(config);
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(JSON.parse(content as string)).toEqual(config);
  });
});

describe("scheduler — 時刻判定ロジック", () => {
  it("enabled=false のときは spawnRun を呼ばない", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...DEFAULT, enabled: false }));

    vi.resetModules();
    const { startScheduler } = await import("../scheduler");
    startScheduler();

    // 最初の setTimeout（次の分の頭）+ check が走る分だけ進める
    await vi.advanceTimersByTimeAsync(61_000);
    expect(spawnRun).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("スケジュール時刻に一致したとき spawnRun を呼ぶ", async () => {
    vi.useFakeTimers();

    // 月曜 09:00 に固定。scheduler は new Date().getDay() などローカル時刻を使うため、
    // テスト設定も同じメソッドで一致させる（環境のタイムゾーンに依存するが両者が整合する）
    const monday9am = new Date("2026-05-11T09:00:00.000Z");
    vi.setSystemTime(monday9am);
    const now = new Date();

    const config: ScheduleConfig = {
      enabled: true,
      dayOfWeek: now.getDay(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      lastRunDate: null,
      pendingDate: null,
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    vi.resetModules();
    const { startScheduler: start } = await import("../scheduler");
    start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(spawnRun).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("既に実行中の run があるときは spawnRun を呼ばず、pendingDate を今日で残す", async () => {
    vi.useFakeTimers();

    const monday9am = new Date("2026-05-11T09:00:00.000Z");
    vi.setSystemTime(monday9am);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const config: ScheduleConfig = {
      enabled: true,
      dayOfWeek: now.getDay(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      lastRunDate: null,
      pendingDate: null,
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
    vi.mocked(hasActiveRun).mockReturnValue(true);

    vi.resetModules();
    const { startScheduler: start } = await import("../scheduler");
    start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(spawnRun).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(content as string) as ScheduleConfig;
    expect(written.lastRunDate).toBeNull();
    expect(written.pendingDate).toBe(today);
    vi.useRealTimers();
  });

  it("pendingDate が今日なら2分ウィンドウを過ぎても spawnRun する", async () => {
    vi.useFakeTimers();

    const now = new Date("2026-05-11T09:03:00.000Z");
    vi.setSystemTime(now);
    const scheduled = new Date(now.getTime() - 3 * 60_000);
    const today = now.toISOString().slice(0, 10);

    const config: ScheduleConfig = {
      enabled: true,
      dayOfWeek: scheduled.getDay(),
      hour: scheduled.getHours(),
      minute: scheduled.getMinutes(),
      lastRunDate: null,
      pendingDate: today,
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    vi.resetModules();
    const { startScheduler: start } = await import("../scheduler");
    start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(spawnRun).toHaveBeenCalledOnce();
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(content as string) as ScheduleConfig;
    expect(written.lastRunDate).toBe(today);
    expect(written.pendingDate).toBeNull();
    vi.useRealTimers();
  });

  it("ウィンドウを過ぎて pendingDate も無いなら spawnRun しない", async () => {
    vi.useFakeTimers();

    const now = new Date("2026-05-11T09:03:00.000Z");
    vi.setSystemTime(now);
    const scheduled = new Date(now.getTime() - 3 * 60_000);

    const config: ScheduleConfig = {
      enabled: true,
      dayOfWeek: scheduled.getDay(),
      hour: scheduled.getHours(),
      minute: scheduled.getMinutes(),
      lastRunDate: null,
      pendingDate: null,
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    vi.resetModules();
    const { startScheduler: start } = await import("../scheduler");
    start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(spawnRun).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("同日に既に実行済みなら spawnRun を呼ばない", async () => {
    vi.useFakeTimers();

    const monday9am = new Date("2026-05-11T09:00:00.000Z");
    vi.setSystemTime(monday9am);
    const now = new Date();
    const today = now.toISOString().slice(0, 10); // scheduler と同じ UTC 日付を使う

    const config: ScheduleConfig = {
      enabled: true,
      dayOfWeek: now.getDay(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      lastRunDate: today,
      pendingDate: null,
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    vi.resetModules();
    const { startScheduler: start } = await import("../scheduler");
    start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(spawnRun).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
