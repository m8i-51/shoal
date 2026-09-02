import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadShoalEnv, resolveEnvPath, stripEmptyAwsCredentials } from "../load-env";

const ENV_KEYS = [
  "SHOAL_ENV_FILE",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "FOO",
  "BAZ",
  "CUSTOM_ONLY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shoal-env-"));
}

describe("resolveEnvPath", () => {
  it("cwd の .env をデフォルトにする", () => {
    expect(resolveEnvPath({ cwd: "/proj" })).toBe(path.join("/proj", ".env"));
  });

  it("envFile オプションを優先する", () => {
    process.env.SHOAL_ENV_FILE = "/ignored.env";
    expect(resolveEnvPath({ cwd: "/proj", envFile: "nested/.env" })).toBe("/proj/nested/.env");
  });

  it("SHOAL_ENV_FILE があればそれを使う", () => {
    process.env.SHOAL_ENV_FILE = "custom.env";
    expect(resolveEnvPath({ cwd: "/proj" })).toBe("/proj/custom.env");
  });
});

describe("stripEmptyAwsCredentials", () => {
  it("空文字と空白のみの AWS キーを削除する", () => {
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "  ",
      AWS_SESSION_TOKEN: "keep-me",
    };
    expect(stripEmptyAwsCredentials(env)).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBe("keep-me");
  });
});

describe("loadShoalEnv", () => {
  it("ファイルがなければ loaded=false で注入 0", () => {
    const cwd = tempDir();
    const result = loadShoalEnv({ cwd, quiet: true });
    expect(result.loaded).toBe(false);
    expect(result.injected).toBe(0);
    expect(result.path).toBe(path.join(cwd, ".env"));
  });

  it(".env を読み、注入件数を返す", () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, ".env"), "FOO=bar\nBAZ=qux\n");
    const result = loadShoalEnv({ cwd, quiet: true });
    expect(result.loaded).toBe(true);
    expect(result.injected).toBe(2);
    expect(process.env.FOO).toBe("bar");
    expect(process.env.BAZ).toBe("qux");
  });

  it("空の AWS キーを読み込んだら削除して strippedAwsKeys に載せる", () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, ".env"), "AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nFOO=1\n");
    const result = loadShoalEnv({ cwd, quiet: true });
    expect(result.loaded).toBe(true);
    expect(result.strippedAwsKeys).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.FOO).toBe("1");
  });

  it("空の AWS キーは既存の環境変数を上書きしない", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAexisting";
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, ".env"), "AWS_ACCESS_KEY_ID=\nFOO=1\n");
    loadShoalEnv({ cwd, quiet: true });
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("AKIAexisting");
  });

  it("SHOAL_ENV_FILE で別パスの .env を読む", () => {
    const cwd = tempDir();
    const custom = path.join(cwd, "nested.env");
    fs.writeFileSync(custom, "CUSTOM_ONLY=yes\n");
    process.env.SHOAL_ENV_FILE = custom;
    const result = loadShoalEnv({ cwd, quiet: true });
    expect(result.loaded).toBe(true);
    expect(result.path).toBe(custom);
    expect(process.env.CUSTOM_ONLY).toBe("yes");
  });

  it("読んだパスと件数を logger に出す", () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, ".env"), "FOO=1\n");
    const lines: string[] = [];
    loadShoalEnv({ cwd, logger: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes("working directory:") && l.includes(cwd))).toBe(true);
    expect(lines.some((l) => l.includes("loaded") && l.includes(".env") && l.includes("1 variable"))).toBe(true);
  });

  it(".env が無いときは読めなかった旨と hint を出す", () => {
    const cwd = tempDir();
    const lines: string[] = [];
    loadShoalEnv({ cwd, logger: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes("no .env found"))).toBe(true);
    expect(lines.some((l) => l.includes("--dir") && l.includes("--env-file"))).toBe(true);
  });
});
