/**
 * diff.ts — PR Experience Diff
 *
 * PR の変更ファイルから影響ルートを推定し、そこへ小さい群れ（デフォルト:
 * browser 2 体・API 0 体）を集中投下して、findings と Experience Score の
 * 変化を PR コメント（または markdown ファイル）にまとめる。
 *
 * Usage:
 *   shoal diff                     # diff vs origin/main
 *   shoal diff --base origin/dev   # diff vs 任意の ref
 *
 * Env:
 *   SHOAL_DIFF_BASE   比較先 ref（--base と同じ、デフォルト origin/main）
 *   SHOAL_PR_NUMBER   コメント先 PR 番号（GitHub Actions では GITHUB_REF から自動解決）
 *   GITHUB_TOKEN / GITHUB_REPO が揃っていれば PR コメント、なければ logs/ に markdown を保存
 */
import { config as loadEnv } from "dotenv";
loadEnv({ override: true });
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { inferRoutesFromFiles, formatDiffSummary, resolvePrNumber, postPrComment } from "./framework/experience-diff";
import { computeExperienceScore } from "./framework/experience-score";
import { isFinding, type Finding } from "./framework/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBaseRef(): string {
  const idx = process.argv.indexOf("--base");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.SHOAL_DIFF_BASE ?? "origin/main";
}

function getChangedFiles(baseRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`[diff] git diff against "${baseRef}" failed — is this a git repository with that ref?`);
    console.error(String(e).slice(0, 300));
    process.exit(1);
  }
}

function loadRunFindings(runId: string): Finding[] {
  const dir = path.join(process.cwd(), "findings", runId);
  if (!fs.existsSync(dir)) return [];
  const findings: Finding[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "triage_result.json") continue;
    try {
      const f: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (isFinding(f)) findings.push(f);
    } catch { /* skip */ }
  }
  return findings;
}

function spawnFocusedRun(runId: string, focusRoutes: string[]): Promise<number> {
  const tsxBin = path.join(__dirname, "node_modules", ".bin", "tsx");
  const bin = fs.existsSync(tsxBin) ? tsxBin : "tsx";
  const script = path.join(__dirname, "run.ts");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHOAL_RUN_ID: runId,
    // PR diff は小規模・集中が身上: ブラウザ 2 体、API 探索なし（env で上書き可）
    MAX_BROWSERS: process.env.MAX_BROWSERS ?? "2",
    MAX_EXPLORERS: process.env.MAX_EXPLORERS ?? "0",
    ...(focusRoutes.length > 0 ? { SHOAL_FOCUS_PATHS: focusRoutes.join(",") } : {}),
  };

  return new Promise((resolve) => {
    const child = spawn(bin, [script], { env, cwd: process.cwd(), stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  const baseRef = getBaseRef();
  const changedFiles = getChangedFiles(baseRef);
  console.log(`[diff] ${changedFiles.length} file(s) changed vs ${baseRef}`);

  const focusRoutes = inferRoutesFromFiles(changedFiles);
  if (focusRoutes.length > 0) {
    console.log(`[diff] inferred routes: ${focusRoutes.join(", ")}`);
  } else {
    console.log("[diff] no route mapping inferred — agents will explore freely");
  }

  const runId = `run_${Date.now()}`;
  console.log(`[diff] starting focused run ${runId}...\n`);
  await spawnFocusedRun(runId, focusRoutes);

  const findings = loadRunFindings(runId);
  const experience = computeExperienceScore();
  const summary = formatDiffSummary({ runId, baseRef, focusRoutes, findings, experience });

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO ?? process.env.GITHUB_REPOSITORY;
  const prNumber = resolvePrNumber();

  if (token && repo && prNumber) {
    const ok = await postPrComment(summary, { token, repo, prNumber });
    if (ok) {
      console.log(`\n[diff] summary posted to ${repo}#${prNumber}`);
      return;
    }
    console.warn("[diff] PR comment failed — falling back to file output");
  }

  const outPath = path.join(process.cwd(), "logs", `diff_${runId}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, summary, "utf-8");
  console.log(`\n${summary}\n\n[diff] summary saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
