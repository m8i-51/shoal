/**
 * triage-only.ts
 * 指定runIdのfindingsを読み込んでトリアージエージェントだけを実行する
 *
 * 使い方:
 *   RUN_ID=run_xxx npx tsx scripts/triage-only.ts
 *   (RUN_ID省略時は最新のrunを使用)
 */

import { loadShoalEnv } from "./framework/load-env";
loadShoalEnv({ quiet: process.env.NODE_ENV === "test" });
import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./framework/llm-client";
import { runTriageAgent } from "./framework/triage";
import { loadCachedSpec } from "./framework/product-discovery";
import { buildTrackers } from "./framework/trackers/index";
import type { Finding } from "./framework/types";
import * as log from "./framework/log";

function loadFindings(runId: string): Finding[] {
  const dir = path.join(process.cwd(), "findings", runId);
  if (!fs.existsSync(dir)) {
    log.error(`findings/${runId} が見つかりません`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "triage_result.json");
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Finding);
}

function getLatestRunId(): string {
  const findingsDir = path.join(process.cwd(), "findings");
  const runs = fs.readdirSync(findingsDir).filter((d) => d.startsWith("run_")).sort();
  if (runs.length === 0) {
    log.error("findingsディレクトリにrunが見つかりません");
    process.exit(1);
  }
  return runs[runs.length - 1];
}

/** 宣言済みの product edge（キャッシュ済み spec から）。BASE_URL 未設定なら無し。 */
function loadProductEdge() {
  try {
    return loadCachedSpec(process.env.BASE_URL ?? "http://localhost:3000")?.productEdge;
  } catch {
    return undefined;
  }
}

async function main() {
  const runId = process.env.RUN_ID ?? getLatestRunId();
  log.info(`[トリアージ単体実行] runId: ${runId}`);

  const findings = loadFindings(runId);
  log.info(`[トリアージ単体実行] findings読み込み: ${findings.length}件`);
  findings.forEach((f) => log.info(`  - ${f.agentName}: ${f.title.slice(0, 50)}`));

  const { client, defaultModel } = createLLMClient();
  const trackers = buildTrackers();
  const result = await runTriageAgent(findings, client, defaultModel, trackers, undefined, loadProductEdge());

  log.print("\n=== トリアージ結果 ===");
  log.print(`  Issue作成: ${result.issuesCreated}件`);
  log.print(`  スキップ: ${result.skipped.length}件`);
  log.print(`  未処理: ${result.unprocessed.length}件`);
  log.print(`  尖りリスク付き: ${result.edgeRisks.length}件`);
}

main().catch((e) => {
  log.error(e);
  process.exitCode = 1;
});
