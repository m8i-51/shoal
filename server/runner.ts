import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

export interface Session {
  sessionId: string;
  startedAt: string;
  completedAt: string | null;
  done: boolean;
  exitCode: number | null;
  lines: string[];
  listeners: ((line: string) => void)[];
  doneListeners: (() => void)[];
  child: ChildProcess | null;
}

export const activeSessions = new Map<string, Session>();

/**
 * How long a finished session's log lines and listeners stay in memory after
 * its process exits. `shoal serve` with the weekly scheduler enabled runs
 * for weeks at a time, and `Session.lines` holds every stdout/stderr line for
 * a run's entire lifetime — without eviction, `activeSessions` grows without
 * bound as runs accumulate. Routes that read historical output (`/api/runs`,
 * `/api/runs/:id/log`, diary) already fall back to the persisted log file
 * when the session is gone from memory. SSE (`/api/runs/:id/events`) does
 * not — it 404s after eviction — so the grace period is sized for "nobody
 * is still watching a finished run live", not "every consumer has a disk
 * fallback".
 */
export const SESSION_RETENTION_MS = 30 * 60 * 1000;

export function spawnRun(opts: {
  baseUrl?: string;
  maxBrowsers?: number;
  maxExplorers?: number;
  maxThresholds?: number;
  mode?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
}): string {
  const sessionId = `run_${Date.now()}`;

  const session: Session = {
    sessionId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    done: false,
    exitCode: null,
    lines: [],
    listeners: [],
    doneListeners: [],
    child: null,
  };
  activeSessions.set(sessionId, session);

  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });

  // ログをリアルタイムでファイルに書き出す（サーバー再起動後もポーリングで読める）
  const logFilePath = join(logsDir, `log_${sessionId}.txt`);
  console.log(`[runner] spawning ${sessionId}, log → ${logFilePath}`);

  // running_*.json で実行中フラグをディスクに残す
  const pendingPath = join(logsDir, `running_${sessionId}.json`);

  const tsxBin = join(packageRoot, "node_modules", ".bin", "tsx");
  const bin = existsSync(tsxBin) ? tsxBin : "tsx";
  const script = join(packageRoot, "run.ts");

  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  if (opts.llmBaseUrl) {
    // A caller-supplied llmBaseUrl must never be able to see the operator's
    // own LLM credentials. Without this, the child would inherit the server's
    // keys and — for the OpenAI-compat path — send LLM_API_KEY/OPENAI_API_KEY
    // as a Bearer token to whatever URL the caller supplied. Strip every
    // provider credential the child could use, not just the two OpenAI-compat
    // keys: ANTHROPIC_API_KEY is the default-provider secret, and AWS_* are
    // what Bedrock reads from the environment. Tracker tokens stay; the child
    // still has to file issues. Only the caller's own key (required alongside
    // llmBaseUrl by the caller) is then written back below.
    delete baseEnv.LLM_API_KEY;
    delete baseEnv.OPENAI_API_KEY;
    delete baseEnv.ANTHROPIC_API_KEY;
    delete baseEnv.AWS_ACCESS_KEY_ID;
    delete baseEnv.AWS_SECRET_ACCESS_KEY;
    delete baseEnv.AWS_SESSION_TOKEN;
    delete baseEnv.LLM_BASE_URL;
    delete baseEnv.LLM_PROVIDER;
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    SHOAL_RUN_ID: sessionId,
    ...(opts.baseUrl ? { BASE_URL: opts.baseUrl } : {}),
    ...(opts.maxBrowsers != null ? { MAX_BROWSERS: String(opts.maxBrowsers) } : {}),
    ...(opts.maxExplorers != null ? { MAX_EXPLORERS: String(opts.maxExplorers) } : {}),
    ...(opts.maxThresholds != null ? { MAX_THRESHOLDS: String(opts.maxThresholds) } : {}),
    ...(opts.mode ? { SHOAL_MODE: opts.mode } : {}),
    ...(opts.llmBaseUrl ? { LLM_BASE_URL: opts.llmBaseUrl } : {}),
    ...(opts.llmApiKey ? { LLM_API_KEY: opts.llmApiKey } : {}),
    ...(opts.llmModel ? { LLM_MODEL: opts.llmModel } : {}),
  };

  const child = spawn(bin, [script], {
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;

  // pid を残しておくと、サーバー再起動後に listRuns() がこの pid の生死を確認して
  // 死んでいる run を「実行中」と誤報告しないようにできる（server/runs.ts 参照）
  writeFileSync(pendingPath, JSON.stringify({ runId: sessionId, startedAt: session.startedAt, pid: child.pid }));

  const emit = (line: string) => {
    session.lines.push(line);
    try { appendFileSync(logFilePath, line + "\n"); } catch { /* ignore */ }
    for (const listener of session.listeners) {
      listener(line);
    }
  };

  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) emit(line);
    });
    stream.on("end", () => {
      if (buf) emit(buf);
    });
  }

  child.on("exit", (code) => {
    session.done = true;
    session.completedAt = new Date().toISOString();
    session.exitCode = code ?? 0;
    try { unlinkSync(pendingPath); } catch { /* ignore */ }
    for (const listener of session.doneListeners) listener();

    const evict = setTimeout(() => {
      // Only drop this exact session object — a cleared-then-recreated
      // sessionId (unlikely given the Date.now() id, but not impossible in a
      // test) must not be evicted out from under a fresh run.
      if (activeSessions.get(sessionId) === session) activeSessions.delete(sessionId);
    }, SESSION_RETENTION_MS);
    evict.unref?.();
  });

  return sessionId;
}

/** Whether a spawned run is still in flight — used to refuse starting a second one concurrently. */
export function hasActiveRun(): boolean {
  for (const session of activeSessions.values()) {
    if (!session.done) return true;
  }
  return false;
}

export function cancelSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || session.done || !session.child) return false;
  try {
    session.child.kill("SIGTERM");
    setTimeout(() => {
      if (!session.done) {
        try { session.child?.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 4000);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM every unfinished session. Returns the ones we actually signalled. */
export function cancelAllSessions(): Session[] {
  const waiting: Session[] = [];
  for (const [sessionId, session] of activeSessions) {
    if (session.done) continue;
    if (cancelSession(sessionId)) waiting.push(session);
  }
  return waiting;
}

/**
 * Resolves when every session has exited, or `timeoutMs` elapses — whichever
 * comes first. Used by `shoal serve` shutdown so `process.exit` doesn't
 * cancel the SIGKILL timer in `cancelSession` and leave the swarm running.
 */
export function waitForSessionsToExit(sessions: Session[], timeoutMs = 5000): Promise<void> {
  if (sessions.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const onDone = () => {
      if (sessions.every((s) => s.done)) done();
    };
    for (const session of sessions) {
      if (!session.done) session.doneListeners.push(onDone);
    }
    onDone();
  });
}
