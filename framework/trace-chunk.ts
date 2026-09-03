import * as fs from "fs";
import * as path from "path";
import type { BrowserContext } from "playwright";
import { scrubTraceZipSafely } from "./trace-scrub";

export function traceFindingZipPath(runId: string, findingId: string, cwd = process.cwd()): string {
  return path.join(cwd, "logs", "traces", runId, `${findingId}.zip`);
}

export function traceAgentZipPath(runId: string, agentId: string, cwd = process.cwd()): string {
  return path.join(cwd, "logs", "traces", runId, `${agentId}.zip`);
}

/** post_feedback 時点までの trace を finding 専用 zip に切り出し、tracing を再開する */
export async function saveFindingTraceChunk(
  context: BrowserContext,
  runId: string,
  findingId: string,
  cwd = process.cwd(),
): Promise<string | null> {
  const tracePath = traceFindingZipPath(runId, findingId, cwd);
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    await context.tracing.stop({ path: tracePath });
    await scrubTraceZipSafely(tracePath, `finding trace ${findingId}`);
    await context.tracing.start({ screenshots: true, snapshots: true });
    return tracePath;
  } catch {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
    } catch { /* ignore */ }
    return null;
  }
}
