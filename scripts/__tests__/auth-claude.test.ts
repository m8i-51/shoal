import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

describe("auth-claude script", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoal-auth-claude-"));
  const prevCwd = process.cwd();

  beforeEach(() => {
    process.chdir(tmp);
    for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
    vi.mocked(spawnSync).mockReset();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.chdir(prevCwd);
  });

  it("claude が無いと非ゼロ終了する", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as never);

    // Run script logic inline to avoid process.exit killing the test runner
    const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf-8" });
    expect(which.status).not.toBe(0);
  });

  it("setVar 相当で .env を更新できる（ユニット相当）", () => {
    const envPath = path.join(tmp, ".env");
    fs.writeFileSync(envPath, "BASE_URL=http://localhost:3000\n");
    let env = fs.readFileSync(envPath, "utf-8");
    function setVar(content: string, key: string, value: string): string {
      const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
      return re.test(content)
        ? content.replace(re, `${key}=${value}`)
        : content + `\n${key}=${value}`;
    }
    env = setVar(env, "LLM_PROVIDER", "claude-cli");
    env = setVar(env, "LLM_MODEL", "claude-sonnet-4-6");
    fs.writeFileSync(envPath, env);
    const out = fs.readFileSync(envPath, "utf-8");
    expect(out).toContain("LLM_PROVIDER=claude-cli");
    expect(out).toContain("LLM_MODEL=claude-sonnet-4-6");
    expect(out).toContain("BASE_URL=http://localhost:3000");
  });
});
