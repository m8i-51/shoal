#!/usr/bin/env tsx
/**
 * auth-claude.ts — Claude Code / Claude CLI subscription setup
 *
 * 1. Verifies `claude` is on PATH
 * 2. Runs `claude auth login` (official Claude Code OAuth flow)
 * 3. Verifies `claude auth status`
 * 4. Writes LLM_PROVIDER=claude-cli and LLM_MODEL to .env
 *
 * Does NOT read, copy, or store OAuth tokens. Auth stays with Claude Code.
 *
 * Usage: npm run auth:claude
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ENV_PATH = path.join(process.cwd(), ".env");

function whichClaude(): string | null {
  const result = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf-8" });
  const p = result.stdout?.trim();
  return p || null;
}

const claudePath = whichClaude();
if (!claudePath) {
  console.error("[auth:claude] `claude` not found on PATH.");
  console.error("  Install Claude Code: https://code.claude.com/docs/en/overview");
  console.error("  Then re-run: npm run auth:claude");
  process.exit(1);
}

console.log(`[auth:claude] Found claude at ${claudePath}`);
console.log("[auth:claude] Running: claude auth login\n");
const login = spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
if (login.status !== 0) {
  console.error("[auth:claude] Login failed (exit code:", login.status, ")");
  process.exit(1);
}

console.log("\n[auth:claude] Checking: claude auth status\n");
const status = spawnSync("claude", ["auth", "status"], { stdio: "inherit" });
if (status.status !== 0) {
  console.error("[auth:claude] auth status failed — log in again with: claude auth login");
  process.exit(1);
}

let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";

function setVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  return re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content + `\n${key}=${value}`;
}

env = setVar(env, "LLM_PROVIDER", "claude-cli");
env = setVar(env, "LLM_MODEL", "claude-sonnet-4-6");
fs.writeFileSync(ENV_PATH, env);

if (process.env.ANTHROPIC_API_KEY?.trim() || /^\s*ANTHROPIC_API_KEY\s*=\s*\S+/m.test(env)) {
  console.warn("\n[auth:claude] warning: ANTHROPIC_API_KEY is set.");
  console.warn("  Claude Code may prefer the API key (pay-as-you-go) over your subscription.");
  console.warn("  To use subscription quota, remove ANTHROPIC_API_KEY from .env and your shell.");
}

console.log("\n[auth:claude] Done.");
console.log("  .env updated: LLM_PROVIDER=claude-cli, LLM_MODEL=claude-sonnet-4-6");
console.log("  Tokens remain managed by Claude Code (shoal never reads them).");
console.log("\nRun `npm start` or `shoal` to launch.");
