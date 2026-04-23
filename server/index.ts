import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import { listRuns, getReportPath } from "./runs.js";
import { activeSessions, spawnRun } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

app.use(express.json());

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
// API: serve HTML report for a run
// ----------------------------------------------------------------
app.get("/api/runs/:runId/report", (req, res) => {
  const reportPath = getReportPath(req.params.runId);
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
  sseStream(req, res, req.params.sessionId);
});

// ----------------------------------------------------------------
// API: SSE — /api/runs/:runId/events（詳細ページ用）
// ----------------------------------------------------------------
app.get("/api/runs/:runId/events", (req, res) => {
  sseStream(req, res, req.params.runId);
});

// ----------------------------------------------------------------
// API: ログ行をまとめて返す（完了後・再起動後もファイルから参照可能）
// ----------------------------------------------------------------
app.get("/api/runs/:runId/log", (req, res) => {
  const { runId } = req.params;

  // 1. アクティブセッション（インメモリ）を優先
  const session = activeSessions.get(runId);
  if (session) {
    res.json({ lines: session.lines, done: session.done, exitCode: session.exitCode });
    return;
  }

  // 2. 保存済みログファイルにフォールバック
  const logFilePath = join(process.cwd(), "logs", `log_${runId}.txt`);
  if (existsSync(logFilePath)) {
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

app.listen(PORT, () => {
  console.log(`\nshoal dashboard → http://localhost:${PORT}\n`);
});
