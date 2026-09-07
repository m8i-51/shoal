import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { createRequire } from "module";
import { resolveDependencyBin } from "../cli-args.js";

const require = createRequire(import.meta.url);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shoal-resolve-bin-"));
  tmpDirs.push(dir);
  return dir;
}

describe("resolveDependencyBin", () => {
  it("packageRoot 直下の node_modules/.bin にバイナリがあればそれを優先する（global install の形）", () => {
    const packageRoot = makeTmpDir();
    const nestedBinDir = join(packageRoot, "node_modules", ".bin");
    mkdirSync(nestedBinDir, { recursive: true });
    const nestedBin = join(nestedBinDir, "tsx");
    writeFileSync(nestedBin, "#!/usr/bin/env node\n");

    expect(resolveDependencyBin(packageRoot, "tsx")).toBe(nestedBin);
  });

  it("nested .bin が無い場合、Node のモジュール解決で実在する tsx CLI を見つける（local install の形）", () => {
    // A packageRoot that has no node_modules/.bin/tsx of its own at all —
    // this is exactly the shape of a local `npm install`, where tsx is
    // hoisted to the *consuming project's* top-level node_modules instead of
    // nested under shoal's own. The old code's only fallback from here was
    // the bare string "tsx", which is what produced `spawn tsx ENOENT`.
    const packageRoot = makeTmpDir();

    const result = resolveDependencyBin(packageRoot, "tsx");

    // Must not fall back to the bare, unresolvable command name...
    expect(result).not.toBe("tsx");
    // ...and must point at a real, invocable file on disk...
    expect(existsSync(result)).toBe(true);
    // ...that is in fact tsx's own declared CLI entry point (its package.json
    // "bin" field), not some other file we happened to find.
    const tsxPkgJsonPath = require.resolve("tsx/package.json");
    const tsxPkg = JSON.parse(readFileSync(tsxPkgJsonPath, "utf8"));
    expect(result).toBe(join(dirname(tsxPkgJsonPath), tsxPkg.bin));
  });

  it("bin フィールドがオブジェクト形式のパッケージ（vite）でも解決できる", () => {
    const packageRoot = makeTmpDir();

    const result = resolveDependencyBin(packageRoot, "vite");

    expect(result).not.toBe("vite");
    expect(existsSync(result)).toBe(true);
    const vitePkgJsonPath = require.resolve("vite/package.json");
    const vitePkg = JSON.parse(readFileSync(vitePkgJsonPath, "utf8"));
    expect(result).toBe(join(dirname(vitePkgJsonPath), vitePkg.bin.vite));
  });

  it("nested パスも Node 解決もどちらも失敗すればベアのパッケージ名にフォールバックする", () => {
    const packageRoot = makeTmpDir();

    expect(resolveDependencyBin(packageRoot, "definitely-not-a-real-shoal-dependency")).toBe(
      "definitely-not-a-real-shoal-dependency",
    );
  });
});
