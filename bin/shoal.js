#!/usr/bin/env node
/**
 * shoal CLI entry point
 *
 * Usage:
 *   shoal init     # interactive setup — creates .env in current directory
 *   shoal config   # update settings in existing .env (e.g. issue trackers)
 *   shoal serve    # web dashboard at http://localhost:4000
 *   shoal          # run agents from the terminal
 *   shoal triage   # triage-only mode
 */
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const subcommand = process.argv[2];

async function main() {
  // init — 対話形式で .env をカレントディレクトリに生成する
  if (subcommand === "init") {
    const { runInit } = await import("./init.js");
    await runInit(process.cwd());
    process.exit(0);
  }

  // config — 既存の .env を対話形式で更新する
  if (subcommand === "config") {
    const { runConfig } = await import("./init.js");
    await runConfig(process.cwd());
    process.exit(0);
  }

  // serve の場合、web/dist が存在しなければ自動ビルドする
  if (subcommand === "serve") {
    const distIndex = join(packageRoot, "web", "dist", "index.html");
    const webSrc = join(packageRoot, "web", "src");
    if (!existsSync(distIndex) && existsSync(webSrc)) {
      console.log("[shoal] web/dist not found — building frontend...");
      const viteBin = join(packageRoot, "node_modules", ".bin", "vite");
      const buildBin = existsSync(viteBin) ? viteBin : "vite";
      const result = spawnSync(buildBin, ["build", "web"], {
        stdio: "inherit",
        cwd: packageRoot,
      });
      if (result.status !== 0) {
        console.error("[shoal] Frontend build failed. Run: npm run build:web");
        process.exit(1);
      }
    }
  }

  const scriptMap = {
    serve: "server/index.ts",
    triage: "triage-only.ts",
  };
  const script = scriptMap[subcommand] ?? "run.ts";

  const tsxBin = join(packageRoot, "node_modules", ".bin", "tsx");
  const bin = existsSync(tsxBin) ? tsxBin : "tsx";
  const scriptPath = join(packageRoot, script);

  const child = spawn(bin, [scriptPath, ...process.argv.slice(subcommand ? 3 : 2)], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
