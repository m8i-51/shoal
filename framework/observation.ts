import type { Page } from "playwright";

export interface ConsoleEntry {
  type: "error" | "warning" | "info" | "log";
  text: string;
  timestamp: string;
}

export interface NetworkError {
  url: string;
  method: string;
  status: number | null;
  errorText: string;
  timestamp: string;
}

export interface ObservationState {
  consoleLogs: ConsoleEntry[];
  networkErrors: NetworkError[];
  previousSnapshot: string | null;
}

export function setupObservation(page: Page): ObservationState {
  const state: ObservationState = { consoleLogs: [], networkErrors: [], previousSnapshot: null };

  page.on("console", (msg) => {
    const type = msg.type() as ConsoleEntry["type"];
    if (type === "error" || type === "warning") {
      state.consoleLogs.push({ type, text: msg.text(), timestamp: new Date().toISOString() });
    }
  });

  page.on("requestfailed", (request) => {
    state.networkErrors.push({
      url: request.url(),
      method: request.method(),
      status: null,
      errorText: request.failure()?.errorText ?? "unknown",
      timestamp: new Date().toISOString(),
    });
  });

  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("/_next/")) {
      state.networkErrors.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        errorText: `HTTP ${response.status()}`,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return state;
}

export function getRecentConsoleLogs(state: ObservationState, limit = 10): ConsoleEntry[] {
  return state.consoleLogs.slice(-limit);
}

export function getRecentNetworkErrors(state: ObservationState, limit = 10): NetworkError[] {
  return state.networkErrors.slice(-limit);
}

export async function readPageText(page: Page, maxLength = 2000): Promise<string> {
  const text = await page.evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const el = node.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            parseFloat(style.opacity) === 0
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      }
    );
    const texts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node.textContent?.trim();
      if (t) texts.push(t);
    }
    return texts.join("\n");
  });
  return text.length > maxLength ? text.slice(0, maxLength) + "\n...(truncated)" : text;
}

export async function saveSnapshotBeforeAction(page: Page, state: ObservationState): Promise<void> {
  try {
    state.previousSnapshot = await page.ariaSnapshot({ mode: "ai", depth: 6 });
  } catch {
    // ignore errors during navigation
  }
}

function normalizeAriaLine(line: string): string {
  return line.trim().replace(/\[ref=\w+\]/g, "").trim();
}

function lcsDiff(oldLines: string[], newLines: string[]): { added: string[]; removed: string[] } {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added.unshift(newLines[j - 1]);
      j--;
    } else {
      removed.unshift(oldLines[i - 1]);
      i--;
    }
  }
  return { added, removed };
}

export async function getDiffFromSnapshot(page: Page, state: ObservationState, maxLength = 2000): Promise<string> {
  if (!state.previousSnapshot) return "(no previous snapshot)";

  let currentSnapshot: string;
  try {
    currentSnapshot = await page.ariaSnapshot({ mode: "ai", depth: 6 });
  } catch {
    return "(failed to get snapshot)";
  }

  const oldLines = state.previousSnapshot.split("\n").map(normalizeAriaLine).filter(Boolean);
  const newLines = currentSnapshot.split("\n").map(normalizeAriaLine).filter(Boolean);

  const { added, removed } = lcsDiff(oldLines, newLines);

  if (added.length === 0 && removed.length === 0) return "no changes";

  const parts: string[] = [];
  if (added.length > 0) parts.push(`added:\n${added.map((l) => `+ ${l}`).join("\n")}`);
  if (removed.length > 0) parts.push(`removed:\n${removed.map((l) => `- ${l}`).join("\n")}`);

  const result = parts.join("\n\n");
  return result.length > maxLength ? result.slice(0, maxLength) + "\n...(省略)" : result;
}

export async function readAccessibilityTree(page: Page, maxLength = 3000): Promise<string> {
  const snapshot = await page.ariaSnapshot({ mode: "ai", depth: 6 });
  return snapshot.length > maxLength ? snapshot.slice(0, maxLength) + "\n...(省略)" : snapshot;
}

export function buildObservationWarning(state: ObservationState): string | null {
  const errors = state.consoleLogs.filter((m) => m.type === "error");
  const fatalNetErrors = state.networkErrors.filter((e) => e.status === null || e.status >= 500);

  if (errors.length === 0 && fatalNetErrors.length === 0) return null;

  const parts: string[] = ["[observation] issues detected:"];
  if (errors.length > 0) {
    parts.push(`JS errors: ${errors.slice(-3).map((e) => e.text).join(" | ")}`);
  }
  if (fatalNetErrors.length > 0) {
    parts.push(`network errors: ${fatalNetErrors.slice(-3).map((e) => `${e.method} ${new URL(e.url).pathname} (${e.errorText})`).join(" | ")}`);
  }
  return parts.join("\n");
}
