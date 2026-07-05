import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";

import {
  buildContextOptions,
  sanitizeEnvironment,
  describeEnvironment,
  applyNetworkThrottle,
  isValidDevice,
  SUGGESTED_DEVICES,
} from "../environment";

describe("SUGGESTED_DEVICES", () => {
  it("提示するデバイス名はすべて Playwright に実在する", () => {
    for (const name of SUGGESTED_DEVICES) {
      expect(isValidDevice(name), `${name} should be a valid Playwright device`).toBe(true);
    }
  });
});

describe("sanitizeEnvironment", () => {
  it("undefined / 空オブジェクトは undefined を返す", () => {
    expect(sanitizeEnvironment(undefined)).toBeUndefined();
    expect(sanitizeEnvironment({})).toBeUndefined();
  });

  it("不正な device 名を取り除く", () => {
    const result = sanitizeEnvironment({ device: "Nokia 3310", locale: "ja-JP" });
    expect(result).toEqual({ locale: "ja-JP" });
  });

  it("有効な値はそのまま通す", () => {
    const env = { device: "iPhone 14", locale: "ja-JP", colorScheme: "dark" as const, reducedMotion: true, networkThrottle: "slow-3g" as const };
    expect(sanitizeEnvironment(env)).toEqual(env);
  });

  it("不正な colorScheme / networkThrottle を取り除く", () => {
    const result = sanitizeEnvironment({ colorScheme: "sepia" as never, networkThrottle: "2g" as never, locale: "en-US" });
    expect(result).toEqual({ locale: "en-US" });
  });
});

describe("buildContextOptions", () => {
  const base = { viewport: { width: 1024, height: 640 } };

  it("環境なしならベースをそのまま返す", () => {
    expect(buildContextOptions(undefined, base)).toEqual(base);
  });

  it("device 指定で Playwright のデバイス設定（モバイル viewport 等）が重なる", () => {
    const opts = buildContextOptions({ device: "iPhone 14" }, base);
    expect(opts.isMobile).toBe(true);
    expect(opts.hasTouch).toBe(true);
    expect(opts.viewport!.width).toBeLessThan(1024);
  });

  it("locale / colorScheme / reducedMotion を設定する", () => {
    const opts = buildContextOptions({ locale: "ja-JP", colorScheme: "dark", reducedMotion: true }, base);
    expect(opts.locale).toBe("ja-JP");
    expect(opts.colorScheme).toBe("dark");
    expect(opts.reducedMotion).toBe("reduce");
    expect(opts.viewport).toEqual(base.viewport); // device なしなら viewport は維持
  });

  it("storageState などベースの他のオプションを保持する", () => {
    const opts = buildContextOptions({ device: "Pixel 7" }, { ...base, storageState: "state.json" });
    expect(opts.storageState).toBe("state.json");
  });
});

describe("applyNetworkThrottle", () => {
  function makePage(sendMock: ReturnType<typeof vi.fn>, cdpFails = false): Page {
    return {
      context: () => ({
        newCDPSession: cdpFails
          ? vi.fn().mockRejectedValue(new Error("not chromium"))
          : vi.fn().mockResolvedValue({ send: sendMock }),
      }),
    } as unknown as Page;
  }

  it("throttle 未指定なら何もしない", async () => {
    const send = vi.fn();
    await applyNetworkThrottle(makePage(send), undefined);
    expect(send).not.toHaveBeenCalled();
  });

  it("slow-3g で CDP の emulateNetworkConditions を呼ぶ", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await applyNetworkThrottle(makePage(send), "slow-3g");
    expect(send).toHaveBeenCalledWith("Network.emulateNetworkConditions", expect.objectContaining({
      offline: false,
      latency: 400,
    }));
  });

  it("CDP が使えなくても例外を投げない", async () => {
    const send = vi.fn();
    await expect(applyNetworkThrottle(makePage(send, true), "fast-3g")).resolves.toBeUndefined();
  });
});

describe("describeEnvironment", () => {
  it("環境なし・空環境は空文字を返す", () => {
    expect(describeEnvironment(undefined)).toBe("");
    expect(describeEnvironment({})).toBe("");
  });

  it("環境の各要素をプロンプト文に含める", () => {
    const text = describeEnvironment({
      device: "iPhone 14",
      locale: "ja-JP",
      colorScheme: "dark",
      reducedMotion: true,
      networkThrottle: "slow-3g",
    });
    expect(text).toContain("[Your Browsing Environment]");
    expect(text).toContain("iPhone 14");
    expect(text).toContain("ja-JP");
    expect(text).toContain("dark mode");
    expect(text).toContain("reduced-motion");
    expect(text).toContain("slow 3g");
  });
});
