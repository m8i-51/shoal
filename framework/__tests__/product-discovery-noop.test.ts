import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../tool-session", () => ({
  runToolSession: vi.fn(),
}));

import * as fs from "fs";
import { runToolSession } from "../tool-session";
import { ToolSessionNoOpError } from "../tool-types";
import { discoverProduct } from "../product-discovery";
import type { LLMClient } from "../llm-client";
import type { Page } from "playwright";

function makeFakePage(): Page {
  return {
    goto: vi.fn(),
    waitForTimeout: vi.fn(),
    evaluate: vi.fn(),
    ariaSnapshot: vi.fn(),
    locator: vi.fn(),
  } as unknown as Page;
}

describe("discoverProduct claude-cli no-op", () => {
  beforeEach(() => {
    vi.mocked(runToolSession).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it("does not save a fallback spec when the session calls no tools", async () => {
    vi.mocked(runToolSession).mockRejectedValue(new ToolSessionNoOpError());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m"),
    ).rejects.toBeInstanceOf(ToolSessionNoOpError);

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("REFRESH_SPEC=1"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("(auto-discovery failed)"));
    errorSpy.mockRestore();
  });
});
