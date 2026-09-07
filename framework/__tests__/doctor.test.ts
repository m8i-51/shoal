import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { runDoctor, formatDoctorReport, type Check } from "../doctor";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: vi.fn(), statSync: vi.fn() };
});

const healthy: NodeJS.ProcessEnv = {
  LLM_PROVIDER: "anthropic",
  LLM_MODEL: "claude-haiku-4-5-20251001",
  ANTHROPIC_API_KEY: "sk-ant-test",
  BASE_URL: "http://localhost:3000",
  SHOAL_MAX_USD: "5",
  GITHUB_TOKEN: "ghp_x",
  GITHUB_REPO: "owner/repo",
  PLAYWRIGHT_BROWSERS_PATH: "/browsers",
  HOME: "/home/test",
};

function report(env: NodeJS.ProcessEnv, nodeVersion = "v22.0.0") {
  return runDoctor({ cwd: "/work", packageRoot: "/pkg", env, nodeVersion });
}

function check(env: NodeJS.ProcessEnv, name: string, nodeVersion?: string): Check {
  const found = report(env, nodeVersion).checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as fs.Stats);
});

afterEach(() => vi.clearAllMocks());

describe("runDoctor", () => {
  it("設定が揃っていれば ok = true", () => {
    const r = report(healthy);
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("fail が1つでもあれば ok = false", () => {
    const r = report({ ...healthy, ANTHROPIC_API_KEY: undefined });
    expect(r.ok).toBe(false);
  });

  it("warn だけなら ok = true のまま（起動は止めない）", () => {
    const r = report({ ...healthy, SHOAL_MAX_USD: undefined });
    expect(r.checks.some((c) => c.status === "warn")).toBe(true);
    expect(r.ok).toBe(true);
  });
});

describe("Node.js", () => {
  it("22 未満は fail", () => {
    expect(check(healthy, "Node.js", "v20.11.0").status).toBe("fail");
  });
  it("22 以上は ok", () => {
    expect(check(healthy, "Node.js", "v24.1.0").status).toBe("ok");
  });
});

describe(".env", () => {
  it("他ユーザーが読めるパーミッションは warn", () => {
    vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100644 } as fs.Stats);
    const c = check(healthy, ".env");
    expect(c.status).toBe("warn");
    expect(c.fix).toContain("chmod 600");
  });

  it("0600 なら ok", () => {
    expect(check(healthy, ".env").status).toBe("ok");
  });

  it("存在しなければ warn（環境変数で動かす構成もあるので fail にしない）", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(check(healthy, ".env").status).toBe("warn");
  });
});

describe("LLM credentials", () => {
  it("anthropic でキーが無ければ fail", () => {
    expect(check({ ...healthy, ANTHROPIC_API_KEY: undefined }, "LLM credentials").status).toBe("fail");
  });

  it("OpenAI 互換で LLM_API_KEY が無ければ fail", () => {
    const env = { ...healthy, LLM_PROVIDER: "groq", ANTHROPIC_API_KEY: undefined };
    expect(check(env, "LLM credentials").status).toBe("fail");
  });

  it("ローカルプロバイダは資格情報不要", () => {
    const env = { ...healthy, LLM_PROVIDER: "ollama", ANTHROPIC_API_KEY: undefined };
    expect(check(env, "LLM credentials").status).toBe("ok");
  });

  it("bedrock は AWS キーが無くても既定の資格情報チェーンにフォールバックする", () => {
    const env = { ...healthy, LLM_PROVIDER: "bedrock", ANTHROPIC_API_KEY: undefined };
    const c = check(env, "LLM credentials");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("default AWS credential chain");
  });

  it("claude-cli に ANTHROPIC_API_KEY が残っていると課金先が変わるので warn", () => {
    const env = { ...healthy, LLM_PROVIDER: "claude-cli" };
    const c = check(env, "LLM credentials");
    expect(c.status).toBe("warn");
    expect(c.fix).toContain("subscription");
  });
});

describe("Spend cap", () => {
  it("未設定は warn", () => {
    expect(check({ ...healthy, SHOAL_MAX_USD: undefined }, "Spend cap").status).toBe("warn");
  });

  it("価格不明のモデルでは上限が発火できないと警告する", () => {
    // The case where an operator believes they are capped and is not.
    const env = { ...healthy, LLM_PROVIDER: "openrouter", LLM_MODEL: "x/unlisted", LLM_API_KEY: "k" };
    const c = check(env, "Spend cap");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("cannot fire");
  });

  it("価格が分かるモデルなら ok", () => {
    expect(check(healthy, "Spend cap").status).toBe("ok");
  });
});

describe("Playwright browser", () => {
  it("どこにも見つからなければ fail", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const c = check({ ...healthy, PLAYWRIGHT_BROWSERS_PATH: undefined }, "Playwright browser");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("playwright install");
  });
});

describe("Target app", () => {
  it("BASE_URL 未設定は fail", () => {
    expect(check({ ...healthy, BASE_URL: undefined }, "Target app").status).toBe("fail");
  });
  it("URL として壊れていれば fail", () => {
    expect(check({ ...healthy, BASE_URL: "localhost:3000" }, "Target app").status).toBe("fail");
  });
  it("http(s) 以外のスキームは fail", () => {
    expect(check({ ...healthy, BASE_URL: "file:///tmp/app" }, "Target app").status).toBe("fail");
  });
});

describe("Issue tracker", () => {
  it("未設定は warn（レポート専用運用は正当な使い方）", () => {
    const env = { ...healthy, GITHUB_TOKEN: undefined, GITHUB_REPO: undefined };
    expect(check(env, "Issue tracker").status).toBe("warn");
  });

  it("有効なのに設定が欠けていれば fail", () => {
    const env = { ...healthy, ISSUE_TRACKERS: "jira" };
    const c = check(env, "Issue tracker");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("JIRA_BASE_URL");
  });
});

describe("settings", () => {
  it("不正な SHOAL_LOG_LEVEL を指摘する", () => {
    const c = check({ ...healthy, SHOAL_LOG_LEVEL: "verbose" }, "SHOAL_LOG_LEVEL");
    expect(c.status).toBe("warn");
  });

  it("SHOAL_LANG は解決後の言語名を表示する", () => {
    expect(check({ ...healthy, SHOAL_LANG: "ja" }, "Output language").detail).toBe("Japanese");
  });
});

describe("formatDoctorReport", () => {
  it("fix 行を出し、結果を要約する", () => {
    const text = formatDoctorReport(report({ ...healthy, ANTHROPIC_API_KEY: undefined }));
    expect(text).toContain("✗");
    expect(text).toContain("→ add ANTHROPIC_API_KEY");
    expect(text).toContain("will stop a run");
  });

  it("全部通れば All checks passed", () => {
    const clean = formatDoctorReport({
      checks: [{ name: "A", status: "ok", detail: "fine" }],
      ok: true,
    });
    expect(clean).toContain("All checks passed.");
  });
});
