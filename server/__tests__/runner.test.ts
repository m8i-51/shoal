import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("fs");

import { spawn } from "child_process";
import * as fs from "fs";
import { spawnRun, cancelSession, activeSessions } from "../runner";

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  activeSessions.clear();
  vi.mocked(spawn).mockClear();
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.appendFileSync).mockReturnValue(undefined);
  vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
});

describe("spawnRun", () => {
  it("sessionId を返し activeSessions に登録する", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const sessionId = spawnRun({});
    expect(sessionId).toMatch(/^run_\d+$/);
    expect(activeSessions.has(sessionId)).toBe(true);
    expect(activeSessions.get(sessionId)?.done).toBe(false);
  });

  it("logs ディレクトリを作成し running_*.json を書き込む", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    spawnRun({});
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("logs"), { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("running_run_"), expect.any(String));
  });

  it("opts を env 変数として子プロセスに渡す", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    spawnRun({ baseUrl: "https://example.com", maxBrowsers: 3 });
    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0];
    expect((spawnOpts as { env: Record<string, string> }).env.BASE_URL).toBe("https://example.com");
    expect((spawnOpts as { env: Record<string, string> }).env.MAX_BROWSERS).toBe("3");
  });

  it("stdout のデータを改行区切りで session.lines に積み、listener に通知する", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const sessionId = spawnRun({});
    const session = activeSessions.get(sessionId)!;
    const received: string[] = [];
    session.listeners.push((line) => received.push(line));

    fakeChild.stdout.emit("data", Buffer.from("line1\nline2\n"));

    expect(session.lines).toEqual(["line1", "line2"]);
    expect(received).toEqual(["line1", "line2"]);
    expect(fs.appendFileSync).toHaveBeenCalledWith(expect.stringContaining("log_run_"), "line1\n");
  });

  it("改行で終わらない残りのバッファは end イベントで flush される", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const sessionId = spawnRun({});
    const session = activeSessions.get(sessionId)!;

    fakeChild.stdout.emit("data", Buffer.from("partial line without newline"));
    expect(session.lines).toEqual([]);

    fakeChild.stdout.emit("end");
    expect(session.lines).toEqual(["partial line without newline"]);
  });

  it("子プロセスの exit で done/exitCode が設定され doneListener に通知、pending ファイルを削除する", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const sessionId = spawnRun({});
    const session = activeSessions.get(sessionId)!;
    let notified = false;
    session.doneListeners.push(() => { notified = true; });

    fakeChild.emit("exit", 0);

    expect(session.done).toBe(true);
    expect(session.exitCode).toBe(0);
    expect(session.completedAt).not.toBeNull();
    expect(notified).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("running_run_"));
  });

  it("exit コードが null の場合は exitCode を 0 にフォールバックする", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const sessionId = spawnRun({});
    fakeChild.emit("exit", null);
    expect(activeSessions.get(sessionId)?.exitCode).toBe(0);
  });
});

describe("cancelSession", () => {
  it("存在しない session → false", () => {
    expect(cancelSession("run_nope")).toBe(false);
  });

  it("既に done な session → false", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);
    const sessionId = spawnRun({});
    fakeChild.emit("exit", 0);

    expect(cancelSession(sessionId)).toBe(false);
  });

  it("child が無い session → false", () => {
    activeSessions.set("run_nochild", {
      sessionId: "run_nochild", startedAt: "", completedAt: null, done: false,
      exitCode: null, lines: [], listeners: [], doneListeners: [], child: null,
    });
    expect(cancelSession("run_nochild")).toBe(false);
  });

  it("実行中の session を SIGTERM で kill して true を返す", () => {
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);
    const sessionId = spawnRun({});

    expect(cancelSession(sessionId)).toBe(true);
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("4秒経っても done でなければ SIGKILL を送る", () => {
    vi.useFakeTimers();
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);
    const sessionId = spawnRun({});

    cancelSession(sessionId);
    vi.advanceTimersByTime(4000);

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("4秒以内に done になっていれば SIGKILL は送らない", () => {
    vi.useFakeTimers();
    const fakeChild = createFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);
    const sessionId = spawnRun({});

    cancelSession(sessionId);
    fakeChild.emit("exit", 0);
    vi.advanceTimersByTime(4000);

    expect(fakeChild.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });
});
