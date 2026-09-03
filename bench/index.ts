/**
 * shoal-bench — shoal の検出力ベンチマーク。
 *
 * バグを仕込んだサンプルアプリ（bench/app.ts, bench/forms-app.ts）を起動し、
 * 通常の run を実行して findings を正解ラベルと突合した検出率を出す。
 *
 * Usage:
 *   npm run bench                         # store variant (default)
 *   BENCH_VARIANT=forms npm run bench     # forms variant
 *   BENCH_RECORD=1 npm run bench          # append score to bench/scores.json
 */
import { loadShoalEnv } from "../framework/load-env";
loadShoalEnv({ quiet: process.env.NODE_ENV === "test" });
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadLabels, loadRunFindings, scoreFindings, formatBenchResult, recordBenchScore } from "./score";
import { labelsPathForVariant, resolveBenchVariant } from "./variants";
import { createLLMClient } from "../framework/llm-client";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(benchDir, "..");

/**
 * The model a recorded score should be attributed to.
 *
 * `bench` used to read `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `SHOAL_MODEL` —
 * none of which shoal itself ever sets; the real variable is `LLM_MODEL`
 * (`LLM_PROVIDER` selects the provider). That mismatch meant `BENCH_RECORD=1`
 * always recorded "unknown", so a score in `bench/scores.json` could not be
 * told apart from any other run. `run.ts` runs as a separate child process,
 * but `createLLMClient()` is a pure function of the same env vars this
 * process already has (and inherits into the child), so calling it here
 * reproduces exactly what the child will resolve to, without touching the
 * network — provider client construction is lazy in every provider's SDK.
 */
export function resolveBenchModelLabel(): string {
  const { provider, defaultModel } = createLLMClient();
  return `${provider}/${defaultModel}`;
}

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
        REFRESH_SPEC: "1",
        SHOAL_TRACE: process.env.SHOAL_TRACE ?? "0",
        ISSUE_TRACKERS: "",
        GITHUB_TOKEN: "",
        GITHUB_REPO: "",
      },
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  const variant = resolveBenchVariant();
  const port = parseInt(process.env.BENCH_PORT ?? String(variant.defaultPort), 10);
  const app = variant.createApp();
  const server = app.listen(port);
  const baseUrl = `http://localhost:${port}`;
  console.log(`[bench] ${variant.id} app → ${baseUrl}`);

  const runId = `run_${Date.now()}`;
  try {
    await runShoal(runId, baseUrl);
  } finally {
    server.close();
  }

  const labels = loadLabels(labelsPathForVariant(variant));
  const findings = loadRunFindings(runId);
  const result = scoreFindings(findings, labels);

  console.log(`\n${formatBenchResult(result, variant.id)}\n`);

  const outDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `bench_${variant.id}_${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ runId, variant: variant.id, ...result }, null, 2), "utf-8");
  console.log(`[bench] result saved: ${outPath}`);

  if (process.env.BENCH_RECORD === "1") {
    recordBenchScore({
      variant: variant.id,
      model: resolveBenchModelLabel(),
      detectionRate: Math.round(result.detectionRate * 100),
      totalFindings: result.totalFindings,
      runDate: new Date().toISOString().slice(0, 10),
      config: `MAX_BROWSERS=${process.env.MAX_BROWSERS ?? "3"}`,
      precision: result.precision,
      unmatchedFindings: result.unmatchedFindings,
    });
    console.log("[bench] score appended to bench/scores.json");
  }

  const min = parseInt(process.env.SHOAL_BENCH_MIN ?? "", 10);
  if (Number.isFinite(min) && result.detectionRate * 100 < min) {
    console.error(`[bench] detection rate ${Math.round(result.detectionRate * 100)}% is below SHOAL_BENCH_MIN=${min}`);
    process.exitCode = 1;
  }
}

// Guarded so this file can be imported (e.g. to unit-test resolveBenchModelLabel)
// without spinning up the seeded app and spawning a full shoal run.
if (process.env.NODE_ENV !== "test") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
