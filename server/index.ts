import { loadShoalEnv } from "../framework/load-env.js";
loadShoalEnv({ quiet: process.env.NODE_ENV === "test" });
import express from "express";
import { rateLimit } from "express-rate-limit";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { listRuns, getReportPath } from "./runs.js";
import { activeSessions, spawnRun, cancelSession } from "./runner.js";
import { loadSchedule, saveSchedule, startScheduler, type ScheduleConfig } from "./scheduler.js";
import { generateDiary, getDiaryPath } from "../framework/diary.js";
import { findCrossRunDuplicates } from "../framework/cross-run-dedup.js";
import { computeExperienceScore } from "../framework/experience-score.js";
import { loadSiteMap, buildSiteMapDashboardView } from "../framework/site-map.js";
import { isFinding, type Finding } from "../framework/types.js";
import { buildSafeProxyUrl } from "./proxy-url.js";
import { hostGuard, requireToken, resolveBinding, resolveDashboardToken } from "./auth.js";
import {
  addAgent,
  archiveAgent,
  listFixedPersonas,
  restoreAgent,
  updateAgent,
  isFixedAgent,
  loadAgents,
} from "../framework/agent-store.js";
import {
  generatePersonaFromSeed,
  PersonaGenerationError,
} from "../framework/persona-from-seed.js";
import type { ProductSpec } from "../framework/product-discovery.js";

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
const binding = resolveBinding();
const auth = resolveDashboardToken(binding);

app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));
// Host / Origin checks apply to the whole app; the token gates the API, so the
// static bundle can still load and then authenticate its own calls.
app.use(hostGuard(binding));
app.use("/api", requireToken(auth.token));

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
// API: fixed personas (seed → generate)
// ----------------------------------------------------------------
function loadProductSpecOrNull(): ProductSpec | null {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const filePath = specFilePath(baseUrl);
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as ProductSpec;
  } catch {
    return null;
  }
}

const personaCreateLimiter = rateLimit({ windowMs: 60_000, limit: 10 });

app.get("/api/personas", (req, res) => {
  const includeArchived = req.query.archived === "1" || req.query.archived === "true";
  res.json(listFixedPersonas({ includeArchived }));
});

app.post("/api/personas", personaCreateLimiter, async (req, res) => {
  const seed = typeof req.body?.seed === "string" ? req.body.seed.trim() : "";
  if (!seed) {
    res.status(400).json({ error: "seed is required" });
    return;
  }
  const spec = loadProductSpecOrNull();
  if (!spec) {
    res.status(400).json({
      error: "product spec required — start a run or set app goals first",
    });
    return;
  }
  try {
    const generated = await generatePersonaFromSeed(seed, spec);
    const agent = addAgent({
      name: generated.name,
      role: generated.role,
      persona: generated.persona,
      lenses: generated.lenses,
      origin: "fixed",
      status: "active",
      seed,
      ...(generated.accountRole ? { accountRole: generated.accountRole } : {}),
    });
    res.status(201).json(agent);
  } catch (e) {
    if (e instanceof PersonaGenerationError) {
      res.status(502).json({ error: e.message });
      return;
    }
    console.error("[personas] generate failed:", e);
    res.status(502).json({ error: "persona generation failed" });
  }
});

app.patch("/api/personas/:id", (req, res) => {
  const id = req.params.id;
  const existing = loadAgents().find((a) => a.id === id);
  if (!existing || !isFixedAgent(existing)) {
    res.status(404).json({ error: "persona not found" });
    return;
  }
  const { name, role, persona, lenses, accountRole } = req.body as {
    name?: unknown;
    role?: unknown;
    persona?: unknown;
    lenses?: unknown;
    accountRole?: unknown;
  };
  if (lenses !== undefined && (!Array.isArray(lenses) || !lenses.every((l) => typeof l === "string"))) {
    res.status(400).json({ error: "lenses must be an array of strings" });
    return;
  }
  try {
    const updated = updateAgent(id, {
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof role === "string" ? { role } : {}),
      ...(typeof persona === "string" ? { persona } : {}),
      ...(lenses !== undefined ? { lenses: lenses as string[] } : {}),
      ...(typeof accountRole === "string" || accountRole === null
        ? { accountRole: accountRole as string | null }
        : {}),
    });
    if (!updated) {
      res.status(400).json({ error: "persona must be active fixed to edit — restore first" });
      return;
    }
    res.json(updated);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: message });
  }
});

app.post("/api/personas/:id/archive", (req, res) => {
  const agent = archiveAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "persona not found" });
    return;
  }
  res.json(agent);
});

app.post("/api/personas/:id/restore", (req, res) => {
  const agent = restoreAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "persona not found" });
    return;
  }
  res.json(agent);
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
// API: experience score — run 横断の体験スコアトレンド
// ----------------------------------------------------------------
app.get("/api/experience", (_req, res) => {
  try {
    const score = computeExperienceScore();
    if (!score) { res.status(404).json({ error: "no experience data yet" }); return; }
    res.json(score);
  } catch {
    res.status(500).json({ error: "failed to compute experience score" });
  }
});

// ----------------------------------------------------------------
// API: site map — path coverage for dashboard
// ----------------------------------------------------------------
app.get("/api/site-map", (_req, res) => {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  try {
    const origin = new URL(baseUrl).origin;
    const map = loadSiteMap(origin);
    const view = buildSiteMapDashboardView(map);
    if (view.stats.known === 0) {
      res.status(404).json({ error: "no site map data yet" });
      return;
    }
    res.json(view);
  } catch {
    res.status(500).json({ error: "failed to read site map" });
  }
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
        if (!file.endsWith(".json") || file === "triage_result.json") continue;
        try {
          const f: unknown = JSON.parse(readFileSync(join(dir, file), "utf-8"));
          if (!isFinding(f)) continue;
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

app.get("/api/findings/cross-run-duplicates", (_req, res) => {
  res.json(findCrossRunDuplicates(loadAllFindings()));
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
  const safeUrl = buildSafeProxyUrl(url);
  // Prefix must be a string literal at this sink (allowlist reconstruction alone is not enough for CodeQL).
  if (
    !safeUrl
    || (
      !safeUrl.startsWith("https://raw.githubusercontent.com/")
      && !safeUrl.startsWith("https://gist.githubusercontent.com/")
    )
  ) {
    res.status(400).json({ error: "host not allowed" });
    return;
  }
  try {
    const upstream = await fetch(safeUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
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
  const { baseUrl, maxBrowsers, maxExplorers, maxThresholds, mode, llmBaseUrl, llmApiKey, llmModel } = req.body as {
    baseUrl?: string;
    maxBrowsers?: number;
    maxExplorers?: number;
    maxThresholds?: number;
    mode?: string;
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;
  };
  if (mode !== undefined && !["read-only", "safe", "full"].includes(mode)) {
    res.status(400).json({ error: "mode must be one of: read-only, safe, full" });
    return;
  }
  const sessionId = spawnRun({ baseUrl, maxBrowsers, maxExplorers, maxThresholds, mode, llmBaseUrl, llmApiKey, llmModel });
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

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(binding.port, binding.host, () => {
    const displayHost = binding.isLoopback ? "localhost" : binding.host;
    console.log(`\nshoal dashboard → http://${displayHost}:${binding.port}`);
    for (const notice of auth.notices) console.log(notice);
    console.log("");
    startScheduler();
  });
}
