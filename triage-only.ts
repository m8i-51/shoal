/**
 * triage-only.ts
 * 指定runIdのfindingsを読み込んでトリアージエージェントだけを実行する
 *
 * 使い方:
 *   RUN_ID=run_xxx npx tsx scripts/triage-only.ts
 *   (RUN_ID省略時は最新のrunを使用)
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./framework/llm-client";
import { runTriageAgent } from "./framework/triage";
import type { Finding } from "./framework/types";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";

function loadFindings(runId: string): Finding[] {
  const dir = path.join(process.cwd(), "findings", runId);
  if (!fs.existsSync(dir)) {
    console.error(`findings/${runId} が見つかりません`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "triage_result.json");
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Finding);
}

function getLatestRunId(): string {
  const findingsDir = path.join(process.cwd(), "findings");
  const runs = fs.readdirSync(findingsDir).filter((d) => d.startsWith("run_")).sort();
  if (runs.length === 0) {
    console.error("findingsディレクトリにrunが見つかりません");
    process.exit(1);
  }
  return runs[runs.length - 1];
}

async function main() {
  const runId = process.env.RUN_ID ?? getLatestRunId();
  console.log(`[トリアージ単体実行] runId: ${runId}`);

  const findings = loadFindings(runId);
  console.log(`[トリアージ単体実行] findings読み込み: ${findings.length}件`);
  findings.forEach((f) => console.log(`  - ${f.agentName}: ${f.title.slice(0, 50)}`));

  const { client, defaultModel } = createLLMClient();
  const result = await runTriageAgent(findings, client, defaultModel, { token: GITHUB_TOKEN, repo: GITHUB_REPO });

  console.log("\n=== トリアージ結果 ===");
  console.log(`  Issue作成: ${result.issuesCreated}件`);
  console.log(`  スキップ: ${result.skipped.length}件`);
  console.log(`  未処理: ${result.unprocessed.length}件`);
}

main().catch(console.error);
