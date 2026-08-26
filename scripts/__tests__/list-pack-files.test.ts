import { describe, it, expect } from "vitest";
import { packFilePaths } from "../list-pack-files.js";

describe("packFilePaths", () => {
  it("npm 10 の配列形式を読む", () => {
    const json = [{
      filename: "m8i-51-shoal-0.1.24.tgz",
      files: [{ path: "run.ts" }, { path: "diff.ts" }, { path: "bin/shoal.js" }],
    }];
    expect(packFilePaths(json)).toEqual(["run.ts", "diff.ts", "bin/shoal.js"]);
  });

  it("npm 12 のパッケージ名キー形式を読む", () => {
    const json = {
      "@m8i-51/shoal": {
        filename: "m8i-51-shoal-0.1.24.tgz",
        files: [{ path: "run.ts" }, { path: "server/index.ts" }],
      },
    };
    expect(packFilePaths(json)).toEqual(["run.ts", "server/index.ts"]);
  });

  it("想定外の形なら例外にする", () => {
    expect(() => packFilePaths({ ok: true })).toThrow(/unexpected npm pack --json shape/);
  });
});
