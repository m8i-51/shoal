import "dotenv/config";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { listRuns, getReportPath } from "./runs.js";
import { activeSessions, spawnRun, cancelSession } from "./runner.js";
import { loadSchedule, saveSchedule, startScheduler, type ScheduleConfig } from "./scheduler.js";
import { generateDiary, getDiaryPath } from "../framework/diary.js";
import type { Finding } from "../framework/types.js";

function specFilePath(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).host.replace(/[^a-zA-Z0-9]/g, "-");
    return join(process.cwd(), "product-specs", `${host}.json`);
  } catch {
    return "";
  }
}

const RUN_ID_RE = /^run_\d+$/;
function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

const logsBase = resolve(process.cwd(), "logs");
function safeLogPath(filename: string): string | null {
  const p = resolve(logsBase, filename);
  return p.startsWith(logsBase + "/") ? p : null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

// ----------------------------------------------------------------
// API: product spec (goals)
// ----------------------------------------------------------------
app.get("/api/spec", (_req, res) => {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const filePath = specFilePath(baseUrl);
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "spec not found" });
    return;
  }
  try {
    res.json(JSON.parse(readFileSync(filePath, "utf-8")));
  } catch {
    res.status(500).json({ error: "failed to read spec" });
  }
});

app.patch("/api/spec/goals", (req, res) => {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const filePath = specFilePath(baseUrl);
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "spec not found" });
    return;
  }
  const { goals } = req.body as { goals?: unknown };
  if (!Array.isArray(goals) || !goals.every((g) => typeof g === "string")) {
    res.status(400).json({ error: "goals must be an array of strings" });
    return;
  }
  try {
    const spec = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    spec.appGoals = goals;
    writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf-8");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "failed to update spec" });
  }
});

// ----------------------------------------------------------------
// API: list runs（アクティブなセッション情報で補完）
// ----------------------------------------------------------------
app.get("/api/runs", (_req, res) => {
  const runs = listRuns();

  // activeSessions が持つ isLive フラグで補完（インメモリ情報が優先）
  const enriched = runs.map((r) => {
    const session = activeSessions.get(r.runId);
    if (session) return { ...r, isLive: !session.done };
    return r;
  });

  res.json(enriched);
});

// ----------------------------------------------------------------
// API: diary for a run
// ----------------------------------------------------------------
app.get("/api/runs/:runId/diary", (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) { res.status(400).json({ error: "invalid run id" }); return; }
  const p = getDiaryPath(runId);
  if (!p) { res.status(404).json({ error: "diary not found" }); return; }
  res.json({ content: readFileSync(p, "utf-8") });
});

app.post("/api/runs/:runId/diary", async (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) { res.status(400).json({ error: "invalid run id" }); return; }

  const session = activeSessions.get(runId);
  let lines: string[];
  if (session) {
    lines = session.lines;
  } else {
    const logFilePath = safeLogPath(`log_${runId}.txt`);
    if (!logFilePath || !existsSync(logFilePath)) {
      res.status(404).json({ error: "no log found" });
      return;
    }
    lines = readFileSync(logFilePath, "utf-8").split("\n").filter((l) => l !== "");
  }

  try {
    const content = await generateDiary(runId, lines);
    res.json({ content });
  } catch (err) {
    console.error("[diary] generation failed:", err);
    res.status(500).json({ error: "diary generation failed" });
  }
});

// ----------------------------------------------------------------
// API: Hall of Issues — 全 run の findings を横断取得
// ----------------------------------------------------------------
function loadAllFindings(): (Finding & { runId: string })[] {
  const base = resolve(process.cwd(), "findings");
  if (!existsSync(base)) return [];
  const all: (Finding & { runId: string })[] = [];
  for (const runDir of readdirSync(base)) {
    if (!/^run_\d+$/.test(runDir)) continue;
    const dir = join(base, runDir);
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const f: Finding = JSON.parse(readFileSync(join(dir, file), "utf-8"));
          all.push({ ...f, runId: runDir });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

app.get("/api/findings", (_req, res) => {
  res.json(loadAllFindings());
});

app.get("/api/findings/export", (_req, res) => {
  const findings = loadAllFindings().map(({ id, title, body, category, agentName, role, timestamp, runId }) => ({
    id, title, body, category, agentName, role, timestamp, runId,
  }));
  const bundle = { version: "1", exportedAt: new Date().toISOString(), source: "shoal", findings };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="shoal-findings-${Date.now()}.json"`);
  res.json(bundle);
});

app.post("/api/findings/proxy-url", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url || typeof url !== "string") { res.status(400).json({ error: "url required" }); return; }
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    const h = parsed.hostname;
    const bare = h.replace(/^\[|\]$/g, ""); // IPv6 brackets: [::1] → ::1
    if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare.startsWith("192.168.") || bare.startsWith("10.") || bare.endsWith(".local")) {
      res.status(400).json({ error: "private urls not allowed" });
      return;
    }
  } catch {
    res.status(400).json({ error: "invalid url" });
    return;
  }
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) { res.status(502).json({ error: "upstream error" }); return; }
    const data = await upstream.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "failed to fetch url" });
  }
});

// ----------------------------------------------------------------
// API: serve HTML report for a run
// ----------------------------------------------------------------
app.get("/api/runs/:runId/report", (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) {
    res.status(400).json({ error: "invalid run id" });
    return;
  }
  const reportPath = getReportPath(runId);
  if (!reportPath) {
    res.status(404).json({ error: "report not found" });
    return;
  }
  res.sendFile(reportPath);
});

// ----------------------------------------------------------------
// API: start a run
// ----------------------------------------------------------------
app.post("/api/runs/start", (req, res) => {
  const { baseUrl, maxBrowsers, maxExplorers, llmBaseUrl, llmApiKey, llmModel } = req.body as {
    baseUrl?: string;
    maxBrowsers?: number;
    maxExplorers?: number;
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;
  };
  const sessionId = spawnRun({ baseUrl, maxBrowsers, maxExplorers, llmBaseUrl, llmApiKey, llmModel });
  res.json({ sessionId });
});

// ----------------------------------------------------------------
// API: cancel a running run
// ----------------------------------------------------------------
app.post("/api/runs/:runId/cancel", (req, res) => {
  const ok = cancelSession(req.params.runId);
  res.json({ ok });
});

// ----------------------------------------------------------------
// SSE ヘルパー
// ----------------------------------------------------------------
function sseStream(req: express.Request, res: express.Response, sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (line: string) => {
    if (res.destroyed) return;
    try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { /* ignore */ }
  };

  const sendDone = () => {
    if (res.destroyed) return;
    try {
      res.write(`event: done\ndata: ${JSON.stringify({ exitCode: session.exitCode })}\n\n`);
      res.end();
    } catch { /* ignore */ }
  };

  for (const line of session.lines) send(line);

  if (session.done) { sendDone(); return; }

  session.listeners.push(send);
  session.doneListeners.push(sendDone);

  req.on("close", () => {
    session.listeners = session.listeners.filter((l) => l !== send);
    session.doneListeners = session.doneListeners.filter((l) => l !== sendDone);
  });
}

// ----------------------------------------------------------------
// API: SSE — /api/sessions/:sessionId/events（後方互換）
// ----------------------------------------------------------------
app.get("/api/sessions/:sessionId/events", (req, res) => {
  const { sessionId } = req.params;
  if (!isValidRunId(sessionId)) { res.status(400).json({ error: "invalid session id" }); return; }
  sseStream(req, res, sessionId);
});

// ----------------------------------------------------------------
// API: SSE — /api/runs/:runId/events（詳細ページ用）
// ----------------------------------------------------------------
app.get("/api/runs/:runId/events", (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) { res.status(400).json({ error: "invalid run id" }); return; }
  sseStream(req, res, runId);
});

// ----------------------------------------------------------------
// API: ログ行をまとめて返す（完了後・再起動後もファイルから参照可能）
// ----------------------------------------------------------------
app.get("/api/runs/:runId/log", (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) {
    res.status(400).json({ error: "invalid run id" });
    return;
  }

  // 1. アクティブセッション（インメモリ）を優先
  const session = activeSessions.get(runId);
  if (session) {
    res.json({ lines: session.lines, done: session.done, exitCode: session.exitCode });
    return;
  }

  // 2. 保存済みログファイルにフォールバック
  const logFilePath = safeLogPath(`log_${runId}.txt`);
  if (logFilePath && existsSync(logFilePath)) {
    const lines = readFileSync(logFilePath, "utf-8").split("\n").filter((l) => l !== "");
    res.json({ lines, done: true, exitCode: null });
    return;
  }

  res.status(404).json({ error: "no log found" });
});

// ----------------------------------------------------------------
// Static: serve built React app
// ----------------------------------------------------------------
const distPath = join(__dirname, "..", "web", "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(join(distPath, "index.html"));
  });
} else {
  app.get("/{*splat}", (_req, res) => {
    res.status(503).send("Frontend not built. Run: npm run build:web");
  });
}

// Express エラーハンドラ（クラッシュ防止）
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] unhandled error:", err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: "internal server error" });
  }
});

// Node.js uncaught exception / rejection をログだけしてサーバーを落とさない
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});

// ----------------------------------------------------------------
// API: schedule config
// ----------------------------------------------------------------
app.get("/api/schedule", (_req, res) => {
  res.json(loadSchedule());
});

app.patch("/api/schedule", (req, res) => {
  const current = loadSchedule();
  const { enabled, dayOfWeek, hour, minute } = req.body as Partial<ScheduleConfig>;
  const updated: ScheduleConfig = {
    ...current,
    ...(enabled != null ? { enabled: Boolean(enabled) } : {}),
    ...(dayOfWeek != null && Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6 ? { dayOfWeek } : {}),
    ...(hour != null && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? { hour } : {}),
    ...(minute != null && Number.isInteger(minute) && minute >= 0 && minute <= 59 ? { minute } : {}),
  };
  saveSchedule(updated);
  res.json(updated);
});

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`\nshoal dashboard → http://localhost:${PORT}\n`);
    startScheduler();
  });
}
