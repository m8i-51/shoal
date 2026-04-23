#!/usr/bin/env tsx
/**
 * auth-codex.ts — ChatGPT subscription OAuth setup
 *
 * 1. Runs `npx @openai/codex login` (official Codex CLI OAuth flow)
 * 2. Verifies ~/.codex/auth.json was created
 * 3. Writes LLM_PROVIDER=codex and LLM_MODEL=codex-mini-latest to .env
 *
 * Usage: npm run auth:codex
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const AUTH_JSON = path.join(os.homedir(), ".codex", "auth.json");
const ENV_PATH = path.join(process.cwd(), ".env");

// Run the official Codex CLI login (interactive, inherits TTY)
console.log("[auth:codex] Running: npx @openai/codex login\n");
const result = spawnSync("npx", ["@openai/codex", "login"], { stdio: "inherit" });

if (result.status !== 0) {
  console.error("[auth:codex] Login failed (exit code:", result.status, ")");
  process.exit(1);
}

if (!fs.existsSync(AUTH_JSON)) {
  console.error(`[auth:codex] ${AUTH_JSON} not found after login — something went wrong`);
  process.exit(1);
}

// Update .env
let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";

function setVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  return re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content + `\n${key}=${value}`;
}

env = setVar(env, "LLM_PROVIDER", "codex");
env = setVar(env, "LLM_MODEL", "gpt-5.1-codex-mini");
fs.writeFileSync(ENV_PATH, env);

console.log("\n[auth:codex] Done.");
console.log(`  Token stored at: ${AUTH_JSON}`);
console.log("  .env updated: LLM_PROVIDER=codex, LLM_MODEL=codex-mini-latest");
console.log("\nRun `npm start` to launch shoal.");
