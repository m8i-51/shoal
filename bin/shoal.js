#!/usr/bin/env node
/**
 * shoal CLI entry point
 *
 * Usage:
 *   npx shoal              # run exploration
 *   npx shoal triage       # triage-only mode
 *   npx shoal serve        # local web dashboard (coming soon)
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

const subcommand = process.argv[2];

const scriptMap = {
  serve: "server/index.ts",
  triage: "triage-only.ts",
};
const script = scriptMap[subcommand] ?? "run.ts";

// tsx の bin を package 内から解決し、なければ PATH にフォールバック
const tsxBin = join(packageRoot, "node_modules", ".bin", "tsx");
const bin = existsSync(tsxBin) ? tsxBin : "tsx";
const scriptPath = join(packageRoot, script);

const child = spawn(bin, [scriptPath, ...process.argv.slice(subcommand ? 3 : 2)], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});

child.on("exit", (code) => process.exit(code ?? 0));
