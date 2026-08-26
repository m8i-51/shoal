import { describe, expect, it } from "vitest";
import {
  missingEntrypoints,
  packInfoFromNpmPackJson,
  REQUIRED_PACK_ENTRYPOINTS,
  verifyPackJson,
} from "../verify-pack-entrypoints";

function files(...paths: string[]) {
  return paths.map((path) => ({ path }));
}

const completeFiles = files(...REQUIRED_PACK_ENTRYPOINTS, "package.json", "README.md");

describe("packInfoFromNpmPackJson", () => {
  it("reads npm 10 array output", () => {
    const pack = packInfoFromNpmPackJson([{ name: "@m8i-51/shoal", files: completeFiles }]);
    expect(pack.files.map((f) => f.path)).toContain("diff.ts");
  });

  it("reads npm 12 package-name keyed output", () => {
    const pack = packInfoFromNpmPackJson({
      "@m8i-51/shoal": { name: "@m8i-51/shoal", files: completeFiles },
    });
    expect(pack.files.map((f) => f.path)).toEqual(completeFiles.map((f) => f.path));
  });

  it("reads a bare pack object", () => {
    const pack = packInfoFromNpmPackJson({ files: completeFiles });
    expect(pack.files).toHaveLength(completeFiles.length);
  });

  it("throws on an unexpected shape", () => {
    expect(() => packInfoFromNpmPackJson({ foo: 1 })).toThrow(/unexpected npm pack --json shape/);
  });
});

describe("missingEntrypoints", () => {
  it("returns nothing when every CLI entrypoint is packed", () => {
    expect(missingEntrypoints({ files: completeFiles })).toEqual([]);
  });

  it("reports diff.ts when it is absent", () => {
    const withoutDiff = files(...REQUIRED_PACK_ENTRYPOINTS.filter((f) => f !== "diff.ts"));
    expect(missingEntrypoints({ files: withoutDiff })).toEqual(["diff.ts"]);
  });
});

describe("verifyPackJson", () => {
  it("accepts npm 12 JSON that includes every entrypoint", () => {
    const raw = JSON.stringify({
      "@m8i-51/shoal": { files: completeFiles },
    });
    expect(verifyPackJson(raw)).toEqual({ ok: true });
  });

  it("rejects invalid JSON", () => {
    const result = verifyPackJson("npm warn not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/);
  });

  it("rejects a complete-looking tarball that is missing diff.ts", () => {
    const raw = JSON.stringify([
      { files: files(...REQUIRED_PACK_ENTRYPOINTS.filter((f) => f !== "diff.ts")) },
    ]);
    const result = verifyPackJson(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing CLI entrypoint: diff.ts/);
  });
});
