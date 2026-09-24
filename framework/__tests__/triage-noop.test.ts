import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../tool-session", () => ({
  runToolSession: vi.fn(),
}));

import * as fs from "fs";
import { runToolSession } from "../tool-session";
import { ToolSessionNoOpError } from "../tool-types";
import { runTriageAgent } from "../triage";
import type { Finding } from "../types";
import type { IssueTracker } from "../trackers/index";
import type { LLMClient } from "../llm-client";

function makeFinding(): Finding {
  return {
    id: "f1",
    runId: "run_test",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Bug found",
    body: "details",
    category: "bug",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function makeTracker(): IssueTracker {
  return {
    name: "fake",
    isEmpty: false,
    createIssue: vi.fn().mockResolvedValue("https://example.com/issue/1"),
    fetchOpenIssues: vi.fn().mockResolvedValue([]),
    fetchClosedIssues: vi.fn().mockResolvedValue([]),
    commentOnIssue: vi.fn().mockResolvedValue(true),
  };
}

describe("runTriageAgent claude-cli no-op", () => {
  beforeEach(() => {
    vi.mocked(runToolSession).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
  });

  it("does not write triage_result.json when the session calls no tools", async () => {
    vi.mocked(runToolSession).mockRejectedValue(new ToolSessionNoOpError());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runTriageAgent([makeFinding()], {} as LLMClient, "m", makeTracker()),
    ).rejects.toBeInstanceOf(ToolSessionNoOpError);

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("shoal triage"));
    errorSpy.mockRestore();
  });
});
