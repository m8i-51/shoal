import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * run.ts used to call `main().catch(...)` unconditionally at module scope,
 * with no NODE_ENV guard (unlike server/index.ts and server/mcp.ts) — merely
 * importing the file, for any reason, launched a real Playwright browser and
 * started exploring BASE_URL. That is why the file had 0% test coverage: it
 * could not be imported safely. This test is the regression guard for the
 * fix — importing it here must resolve quickly and must not touch a browser.
 */
describe("run.ts import safety", () => {
  it("importing under NODE_ENV=test does not launch a swarm, and exports main()", async () => {
    const mod = await import("../run");
    expect(typeof mod.main).toBe("function");
  }, 5000);
});

describe("handleFatalRunError", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("a run that never started (e.g. a browser-launch failure) exits non-zero", async () => {
    const { handleFatalRunError } = await import("../run");
    handleFatalRunError(new Error("Executable doesn't exist"));
    expect(process.exitCode).toBe(1);
  });

  it("BudgetExceededError also exits non-zero", async () => {
    const { handleFatalRunError } = await import("../run");
    const { BudgetExceededError } = await import("../framework/budget");
    handleFatalRunError(new BudgetExceededError(5, 4));
    expect(process.exitCode).toBe(1);
  });
});
