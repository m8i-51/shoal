import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderWeeklyWorkflow, parseEnv, updateEnvFile } from "../init.js";

describe("renderWeeklyWorkflow", () => {
  it("generates from the packaged example, not a second hand-written copy", () => {
    const yaml = renderWeeklyWorkflow("https://staging.example.com");

    // Regression guard for the drift the review found: the generated
    // workflow used to hardcode Node 20 / actions@v4 independently of
    // .github/workflows/shoal-weekly.example.yml, which had already moved on.
    expect(yaml).toContain("actions/checkout@v7");
    expect(yaml).toContain("actions/setup-node@v7");
    expect(yaml).toContain("node-version: '22'");
    expect(yaml).not.toContain("actions/checkout@v4");
    expect(yaml).not.toContain("node-version: '20'");
  });

  it("bakes the staging URL in directly and drops the STAGING_URL variable gate", () => {
    const yaml = renderWeeklyWorkflow("https://staging.example.com");

    expect(yaml).toContain('BASE_URL: "https://staging.example.com"');
    expect(yaml).not.toContain("vars.STAGING_URL");
    expect(yaml).not.toContain("if: ${{ vars.STAGING_URL");
    expect(yaml).not.toContain("Required variables: STAGING_URL");
  });

  it("quotes the URL safely even if it contains YAML-special characters", () => {
    const yaml = renderWeeklyWorkflow("https://staging.example.com/path?a=b&c=d");
    expect(yaml).toContain('BASE_URL: "https://staging.example.com/path?a=b&c=d"');
  });

  it("keeps the parts of the template untouched (permissions, cron, install steps)", () => {
    const yaml = renderWeeklyWorkflow("https://staging.example.com");
    expect(yaml).toContain("permissions:");
    expect(yaml).toContain("issues: write");
    expect(yaml).toContain("cron: '0 9 * * 1'");
    expect(yaml).toContain("npx playwright install chromium --with-deps");
    expect(yaml).toContain("GITHUB_REPO: ${{ github.repository }}");
  });
});

describe("parseEnv", () => {
  it("KEY=VALUE の行を読む", () => {
    expect(parseEnv("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("空行とコメント行は無視する", () => {
    expect(parseEnv("# comment\n\nFOO=bar\n  # indented comment\n")).toEqual({ FOO: "bar" });
  });

  it("値に = が含まれても最初の = だけで分割する", () => {
    expect(parseEnv("URL=https://example.com/?a=b")).toEqual({ URL: "https://example.com/?a=b" });
  });

  it("= を含まない行は無視する", () => {
    expect(parseEnv("not-a-kv-line\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  it("空文字列は空オブジェクトを返す", () => {
    expect(parseEnv("")).toEqual({});
  });
});

describe("updateEnvFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("既存の無関係なキーを保持したまま新しいキーを追記する", () => {
    dir = mkdtempSync(join(tmpdir(), "shoal-init-test-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant-existing\nBASE_URL=http://localhost:3000\n");

    updateEnvFile(envPath, { GITHUB_TOKEN: "ghp_new", GITHUB_REPO: "owner/repo" }, []);

    const result = parseEnv(readFileSync(envPath, "utf-8"));
    expect(result).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-existing",
      BASE_URL: "http://localhost:3000",
      GITHUB_TOKEN: "ghp_new",
      GITHUB_REPO: "owner/repo",
    });
  });

  it("removeKeys に挙がったキーの既存行を落としてから新しい値で置き換える", () => {
    dir = mkdtempSync(join(tmpdir(), "shoal-init-test-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant-existing\nGITHUB_TOKEN=old-token\nGITHUB_REPO=old/repo\n");

    updateEnvFile(envPath, { GITHUB_TOKEN: "new-token", GITHUB_REPO: "new/repo" }, ["GITHUB_TOKEN", "GITHUB_REPO"]);

    const result = parseEnv(readFileSync(envPath, "utf-8"));
    expect(result).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-existing",
      GITHUB_TOKEN: "new-token",
      GITHUB_REPO: "new/repo",
    });
  });

  it(".env が存在しなくても新規作成する", () => {
    dir = mkdtempSync(join(tmpdir(), "shoal-init-test-"));
    const envPath = join(dir, ".env");

    updateEnvFile(envPath, { GITHUB_TOKEN: "ghp_new" }, []);

    expect(parseEnv(readFileSync(envPath, "utf-8"))).toEqual({ GITHUB_TOKEN: "ghp_new" });
  });

  it.skipIf(process.platform === "win32")(
    "API キー・トークンを含むので、既存の緩いパーミッションでも 0600 に締め直す",
    () => {
      dir = mkdtempSync(join(tmpdir(), "shoal-init-test-"));
      const envPath = join(dir, ".env");
      // 既存ファイルが緩いパーミッション（0644）で作られていたケースを再現する —
      // writeFileSync の mode オプションはファイル作成時にしか効かないので、
      // 既存ファイルへの上書きでは明示的な chmod が無いと直らない。
      writeFileSync(envPath, "GITHUB_TOKEN=old\n", { mode: 0o644 });

      updateEnvFile(envPath, { GITHUB_TOKEN: "new" }, []);

      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    },
  );
});
