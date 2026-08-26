import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  traceFindingZipPath,
  traceAgentZipPath,
  saveFindingTraceChunk,
} from "../trace-chunk";

describe("trace chunk paths", () => {
  it("finding / agent ごとの zip パスを返す", () => {
    const cwd = "/tmp/shoal";
    expect(traceFindingZipPath("run_1", "a1_123", cwd)).toBe("/tmp/shoal/logs/traces/run_1/a1_123.zip");
    expect(traceAgentZipPath("run_1", "a1", cwd)).toBe("/tmp/shoal/logs/traces/run_1/a1.zip");
  });
});

describe("saveFindingTraceChunk", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trace-chunk-"));

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("tracing を stop/start して finding 専用 zip パスを返す", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(undefined);
    const context = { tracing: { stop, start } } as unknown as import("playwright").BrowserContext;

    const saved = await saveFindingTraceChunk(context, "run_test", "f_1", cwd);
    expect(saved).toBe(traceFindingZipPath("run_test", "f_1", cwd));
    expect(stop).toHaveBeenCalledWith({ path: saved });
    expect(start).toHaveBeenCalledWith({ screenshots: true, snapshots: true });
  });

  it("stop が失敗したら null を返し tracing 再開を試みる", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const context = {
      tracing: {
        stop: vi.fn().mockRejectedValue(new Error("stop failed")),
        start,
      },
    } as unknown as import("playwright").BrowserContext;

    expect(await saveFindingTraceChunk(context, "run_test", "f_2", cwd)).toBeNull();
    expect(start).toHaveBeenCalledWith({ screenshots: true, snapshots: true });
  });
});
