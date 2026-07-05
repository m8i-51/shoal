/**
 * shoal-bench — shoal の検出力ベンチマーク。
 *
 * バグを仕込んだサンプルアプリ（bench/app.ts）を起動し、その上で通常の run を
 * 実行して、findings を正解ラベル（bench/labels.json）と突合した検出率を出す。
 * プロンプト・モデル・探索ロジックを変更したとき、検出力が落ちていないかを
 * 確かめる回帰テストとして使う。
 *
 * Usage:
 *   npm run bench            # ANTHROPIC_API_KEY（等）が必要
 *   BENCH_PORT=4319 npm run bench
 */
import { config as loadEnv } from "dotenv";
loadEnv({ override: true });
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createBenchApp } from "./app";
import { loadLabels, loadRunFindings, scoreFindings, formatBenchResult } from "./score";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(benchDir, "..");

function runShoal(runId: string, baseUrl: string): Promise<number> {
  const tsxBin = path.join(packageRoot, "node_modules", ".bin", "tsx");
  const bin = fs.existsSync(tsxBin) ? tsxBin : "tsx";
  return new Promise((resolve) => {
    const child = spawn(bin, [path.join(packageRoot, "run.ts")], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        SHOAL_RUN_ID: runId,
        BASE_URL: baseUrl,
        MAX_EXPLORERS: "0",
        MAX_BROWSERS: process.env.MAX_BROWSERS ?? "3",
        REFRESH_SPEC: "1", // ベンチアプリは毎回まっさらな理解から始める
        SHOAL_TRACE: process.env.SHOAL_TRACE ?? "0", // ベンチでは trace を省いて高速化
        // ベンチ結果を汚さないよう issue tracker は無効化
        ISSUE_TRACKERS: "",
        GITHUB_TOKEN: "",
        GITHUB_REPO: "",
      },
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  const port = parseInt(process.env.BENCH_PORT ?? "4319", 10);
  const app = createBenchApp();
  const server = app.listen(port);
  const baseUrl = `http://localhost:${port}`;
  console.log(`[bench] sample app → ${baseUrl}`);

  const runId = `run_${Date.now()}`;
  try {
    await runShoal(runId, baseUrl);
  } finally {
    server.close();
  }

  const labels = loadLabels();
  const findings = loadRunFindings(runId);
  const result = scoreFindings(findings, labels);

  console.log(`\n${formatBenchResult(result)}\n`);

  const outDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `bench_${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ runId, ...result }, null, 2), "utf-8");
  console.log(`[bench] result saved: ${outPath}`);

  // SHOAL_BENCH_MIN（0-100）を下回ったら非ゼロ終了 — CI の回帰ゲートに使える
  const min = parseInt(process.env.SHOAL_BENCH_MIN ?? "", 10);
  if (Number.isFinite(min) && result.detectionRate * 100 < min) {
    console.error(`[bench] detection rate ${Math.round(result.detectionRate * 100)}% is below SHOAL_BENCH_MIN=${min}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
