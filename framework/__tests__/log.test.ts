import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as log from "../log";
import { DEFAULT_LOG_LEVEL, LOG_LEVELS, resolveLogLevel } from "../log";

describe("resolveLogLevel", () => {
  it("未設定なら既定（従来と同じ出力量）", () => {
    expect(resolveLogLevel({})).toBe("info");
    expect(DEFAULT_LOG_LEVEL).toBe("info");
  });

  it("大文字・空白を吸収する", () => {
    expect(resolveLogLevel({ SHOAL_LOG_LEVEL: "  DEBUG " })).toBe("debug");
  });

  it("不正値は警告して既定に落ちる（沈黙させない）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A typo must not cost the operator the output they were relying on.
    expect(resolveLogLevel({ SHOAL_LOG_LEVEL: "verbose" })).toBe("info");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("全レベルを受け付ける", () => {
    for (const level of LOG_LEVELS) {
      expect(resolveLogLevel({ SHOAL_LOG_LEVEL: level })).toBe(level);
    }
  });
});

describe("level gating", () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  let warned: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    out = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    out.mockRestore();
    err.mockRestore();
    warned.mockRestore();
    delete process.env.SHOAL_LOG_LEVEL;
  });

  const emitAll = () => {
    log.error("e"); log.warn("w"); log.info("i"); log.debug("d"); log.print("p");
  };

  it("silent は print も含めて全部止める", () => {
    process.env.SHOAL_LOG_LEVEL = "silent";
    emitAll();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });

  it("error はエラーと print だけ通す（静かでも結果は出る）", () => {
    process.env.SHOAL_LOG_LEVEL = "error";
    emitAll();
    expect(err).toHaveBeenCalledWith("e");
    expect(warned).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledWith("p");
  });

  it("warn は info/debug を落とす", () => {
    process.env.SHOAL_LOG_LEVEL = "warn";
    emitAll();
    expect(warned).toHaveBeenCalledWith("w");
    expect(out.mock.calls.flat()).toEqual(["p"]);
  });

  it("既定（info）は debug 以外すべて通す", () => {
    emitAll();
    expect(out.mock.calls.flat()).toEqual(["i", "p"]);
  });

  it("debug は全部通す", () => {
    process.env.SHOAL_LOG_LEVEL = "debug";
    emitAll();
    expect(out.mock.calls.flat()).toEqual(["i", "d", "p"]);
  });

  it("レベルは呼び出しごとに読む（import 時に固定しない）", () => {
    // The dashboard builds a child's env per request and tests set the
    // variable after import; a cached level would be wrong in both.
    log.info("first");
    process.env.SHOAL_LOG_LEVEL = "silent";
    log.info("second");
    expect(out.mock.calls.flat()).toEqual(["first"]);
  });

  it("isDebug が debug 判定に一致する", () => {
    expect(log.isDebug()).toBe(false);
    process.env.SHOAL_LOG_LEVEL = "debug";
    expect(log.isDebug()).toBe(true);
  });
});
