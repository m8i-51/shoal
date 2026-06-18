import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./llm-client.js";
import type { Finding } from "./types.js";

function loadFindings(runId: string): Finding[] {
  const dir = path.join(process.cwd(), "findings", runId);
  if (!fs.existsSync(dir)) return [];
  const out: Finding[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")));
    } catch { /* skip */ }
  }
  return out;
}

function extractEvents(lines: string[]): string[] {
  const events: string[] = [];
  let navCount = 0;
  for (const line of lines) {
    if (/^\[(explorer|browser|regression)\] .+ (start|done|cancelled)/.test(line)) {
      events.push(line.trim());
    } else if (/→ \[findings\] saved:/.test(line)) {
      events.push(line.trim());
    } else if (/→ navigate\(/.test(line) && navCount < 25) {
      navCount++;
      const t = line.trim();
      events.push(t.length > 100 ? t.slice(0, 100) + "…" : t);
    }
  }
  return events;
}

export async function generateDiary(runId: string, logLines: string[]): Promise<string> {
  const findings = loadFindings(runId);
  const events = extractEvents(logLines);

  const findingsSummary = findings.length > 0
    ? findings.map((f) => `- [${f.category}] ${f.title}`).join("\n")
    : "（発見なし）";

  const eventsText = events.length > 0
    ? events.join("\n")
    : "（イベントログなし）";

  const { client, defaultModel } = createLLMClient();

  const msg = await client.createMessage({
    model: defaultModel,
    max_tokens: 1500,
    system: `あなたは AI エージェント群の探索を、読み手の心を動かす「探索日誌」として記録する書記役です。
エンジニアだけでなく、プロダクトオーナーやデザイナーにも伝わる、物語体の日本語で書いてください。
技術的なログを人間味あふれる冒険譚に変換するのがあなたの仕事です。`,
    tools: [],
    messages: [
      {
        role: "user",
        content: `以下の探索ログをもとに、shoal エージェント群の「探索日誌」を Markdown 形式で作成してください。

## 発見された問題（${findings.length}件）
${findingsSummary}

## 主要イベントログ
${eventsText}

## 作成ルール
- タイトルは \`# 探索日誌 — ${runId}\`
- explorer エージェントを「地図製作者」、browser を「現地調査員」、regression を「検証係」として擬人化する
- 各エージェントの動きを旅人の行動として物語る（「〇〇は△△のページへと足を踏み入れた」など）
- 発見した問題を「驚き」や「発見」として自然に物語に組み込む
- 全体で 400〜700 字程度のコンパクトな物語にまとめる
- 最後に「## 今回の旅のまとめ」セクションを箇条書きで追加する
- Markdown のみで出力する（説明文は不要）`,
      },
    ],
  });

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const diaryPath = path.join(process.cwd(), "logs", `diary_${runId}.md`);
  fs.mkdirSync(path.dirname(diaryPath), { recursive: true });
  fs.writeFileSync(diaryPath, text, "utf-8");

  return text;
}

export function getDiaryPath(runId: string): string | null {
  if (!/^run_\d+$/.test(runId)) return null;
  const p = path.join(process.cwd(), "logs", `diary_${runId}.md`);
  return fs.existsSync(p) ? p : null;
}
