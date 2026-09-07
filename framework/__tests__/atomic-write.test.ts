import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeFileAtomic, quarantineCorruptFile } from "../atomic-write";

// Deliberately no `vi.mock("fs")` here: these tests exercise the real
// filesystem (a throwaway tmp dir) so that "atomic" and "no temp file left
// behind" are actually verified on disk, not just asserted against mocks.

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lands the full content at the target path", () => {
    const target = path.join(dir, "state.json");
    const content = JSON.stringify({ hello: "world" }, null, 2);

    writeFileAtomic(target, content);

    expect(fs.readFileSync(target, "utf-8")).toBe(content);
  });

  it("overwrites existing content completely rather than appending", () => {
    const target = path.join(dir, "state.json");
    writeFileAtomic(target, "first-version");
    writeFileAtomic(target, "second-version");

    expect(fs.readFileSync(target, "utf-8")).toBe("second-version");
  });

  it("leaves no temp file behind on success", () => {
    const target = path.join(dir, "state.json");
    writeFileAtomic(target, "hello");

    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["state.json"]);
  });

  it("cleans up the temp file and rethrows when the write cannot complete", () => {
    // Force a failure at the rename step: renaming a regular file onto an
    // existing non-empty directory fails (EISDIR/ENOTEMPTY on POSIX). The
    // temp file has already been written to `dir` by this point, so this
    // exercises the real cleanup path rather than a write that never
    // produced a temp file in the first place.
    const targetDir = path.join(dir, "target");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "keep.txt"), "keep me");

    expect(() => writeFileAtomic(targetDir, "new content")).toThrow();

    // No stray `.tmp-*` file left in the directory the write happened in.
    const leftover = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftover).toEqual([]);

    // The target itself (and its contents) is untouched by the failed write.
    expect(fs.statSync(targetDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, "keep.txt"), "utf-8")).toBe("keep me");
  });

  it("writes the temp file as a sibling of the target (same directory)", () => {
    // A nested target directory makes it obvious the temp file was not
    // dropped somewhere unrelated (e.g. os.tmpdir()) — rename is only
    // atomic within one filesystem, so the temp file must live next to the
    // target. If it had gone into a different directory, this listing of
    // `nested` would show only "state.json" purely by luck; combined with
    // the "no temp file left behind" case above (same directory as target),
    // this pins down that the temp file's directory is `nested`, not some
    // shared scratch location.
    const nested = path.join(dir, "nested", "deep");
    fs.mkdirSync(nested, { recursive: true });
    const target = path.join(nested, "state.json");

    writeFileAtomic(target, "content");

    expect(fs.readdirSync(nested)).toEqual(["state.json"]);
    expect(fs.readFileSync(target, "utf-8")).toBe("content");
    // The rest of the tree is untouched — no stray files climbed up to `dir`.
    expect(fs.readdirSync(dir)).toEqual(["nested"]);
  });
});

describe("quarantineCorruptFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "quarantine-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("moves the corrupt file aside to a .corrupt sibling and warns naming the file", () => {
    const target = path.join(dir, "agents.json");
    fs.writeFileSync(target, "{not-valid-json", "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    quarantineCorruptFile(target, "the agent roster (personas + memory)", new SyntaxError("Unexpected token"));

    // Original path is gone (so the next save doesn't clobber the evidence)...
    expect(fs.existsSync(target)).toBe(false);

    // ...and the content survives at a `.corrupt` sibling.
    const quarantined = fs.readdirSync(dir).find((f) => f.includes(".corrupt-"));
    expect(quarantined).toBeDefined();
    expect(fs.readFileSync(path.join(dir, quarantined!), "utf-8")).toBe("{not-valid-json");

    // The warning is loud and specific: it names the file and what was lost.
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toContain(target);
    expect(message).toContain("the agent roster (personas + memory)");

    warnSpy.mockRestore();
  });

  it("never throws even if the file cannot be moved aside", () => {
    const missing = path.join(dir, "does-not-exist.json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => quarantineCorruptFile(missing, "something", new Error("boom"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
