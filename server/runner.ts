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

export function spawnRun(opts: {
  baseUrl?: string;
  maxBrowsers?: number;
  maxExplorers?: number;
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
  writeFileSync(pendingPath, JSON.stringify({ runId: sessionId, startedAt: session.startedAt }));

  const tsxBin = join(packageRoot, "node_modules", ".bin", "tsx");
  const bin = existsSync(tsxBin) ? tsxBin : "tsx";
  const script = join(packageRoot, "run.ts");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHOAL_RUN_ID: sessionId,
    ...(opts.baseUrl ? { BASE_URL: opts.baseUrl } : {}),
    ...(opts.maxBrowsers != null ? { MAX_BROWSERS: String(opts.maxBrowsers) } : {}),
    ...(opts.maxExplorers != null ? { MAX_EXPLORERS: String(opts.maxExplorers) } : {}),
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
  });

  return sessionId;
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
