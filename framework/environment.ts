import { devices } from "playwright";
import type { BrowserContextOptions, Page } from "playwright";

/**
 * Environment personas — デバイス・ロケール・配色・回線もペルソナの一部にする。
 *
 * HR エージェントがペルソナ生成時に環境プロファイルを割り当てると、
 * ブラウザエージェントはその環境（実デバイスの viewport / タッチ、ダークモード、
 * 遅い回線など）で実際にアプリを体験する。モバイル系・a11y 系の finding が
 * 「推測」ではなく「実体験」になる。
 */

export interface EnvironmentProfile {
  /** Playwright device name (e.g. "iPhone 14", "Pixel 7", "iPad (gen 7)") — omit for desktop */
  device?: string;
  /** BCP 47 locale, e.g. "ja-JP" */
  locale?: string;
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
  networkThrottle?: "slow-3g" | "fast-3g";
}

/** add_agent ツールの description で提示するデバイス例（実在する Playwright device 名） */
export const SUGGESTED_DEVICES = ["iPhone 14", "iPhone SE", "Pixel 7", "Galaxy S9+", "iPad (gen 7)"];

export function isValidDevice(name: string): boolean {
  return name in devices;
}

/** 環境プロファイルの device 名などを検証し、不正な値を取り除いて返す */
export function sanitizeEnvironment(env: EnvironmentProfile | undefined): EnvironmentProfile | undefined {
  if (!env || typeof env !== "object") return undefined;
  const clean: EnvironmentProfile = {};
  if (typeof env.device === "string" && env.device) {
    if (isValidDevice(env.device)) clean.device = env.device;
    else console.warn(`[environment] unknown device "${env.device}" — using desktop`);
  }
  if (typeof env.locale === "string" && env.locale) clean.locale = env.locale;
  if (env.colorScheme === "dark" || env.colorScheme === "light") clean.colorScheme = env.colorScheme;
  if (env.reducedMotion === true) clean.reducedMotion = true;
  if (env.networkThrottle === "slow-3g" || env.networkThrottle === "fast-3g") clean.networkThrottle = env.networkThrottle;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** ベースの context オプションに環境プロファイルを重ねる */
export function buildContextOptions(
  env: EnvironmentProfile | undefined,
  base: BrowserContextOptions = {},
): BrowserContextOptions {
  if (!env) return base;
  const opts: BrowserContextOptions = { ...base };
  if (env.device && isValidDevice(env.device)) {
    Object.assign(opts, devices[env.device]);
  }
  if (env.locale) opts.locale = env.locale;
  if (env.colorScheme) opts.colorScheme = env.colorScheme;
  if (env.reducedMotion) opts.reducedMotion = "reduce";
  return opts;
}

const THROTTLE_PROFILES: Record<NonNullable<EnvironmentProfile["networkThrottle"]>, {
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
}> = {
  // bytes/sec
  "slow-3g": { downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8, latency: 400 },
  "fast-3g": { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
};

/** CDP で回線速度をエミュレートする（Chromium のみ — 失敗しても続行） */
export async function applyNetworkThrottle(page: Page, throttle: EnvironmentProfile["networkThrottle"]): Promise<void> {
  if (!throttle) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...THROTTLE_PROFILES[throttle] });
  } catch (e) {
    console.warn(`[environment] failed to apply network throttle "${throttle}":`, e);
  }
}

/** システムプロンプトに注入する環境の説明 */
export function describeEnvironment(env: EnvironmentProfile | undefined): string {
  if (!env) return "";
  const parts: string[] = [];
  if (env.device) parts.push(`on a ${env.device} (real device viewport & touch input)`);
  if (env.locale) parts.push(`with locale ${env.locale}`);
  if (env.colorScheme === "dark") parts.push("in dark mode");
  if (env.reducedMotion) parts.push("with reduced-motion preference enabled");
  if (env.networkThrottle) parts.push(`over a ${env.networkThrottle.replace("-", " ")} connection`);
  if (parts.length === 0) return "";

  return `
[Your Browsing Environment]
You are browsing ${parts.join(", ")}. This is part of who you are — experience the app exactly as this environment presents it.
Report anything that is broken, cramped, unreadable, slow, or awkward specifically in this environment (e.g. touch targets too small, layouts that break on this screen, unreadable dark-mode contrast, spinners that never resolve on a slow connection).`;
}
