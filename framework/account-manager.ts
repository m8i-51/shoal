import * as fs from "fs";
import * as path from "path";
import type { Page, BrowserContext } from "playwright";
import type { LLMClient } from "./llm-client";
import { runToolSession } from "./tool-session";
import type { ToolResultContent } from "./tool-types";
import { saveFinding } from "./findings";
import {
  setupObservation,
  readPageText,
  readAccessibilityTree,
  saveSnapshotBeforeAction,
} from "./observation";
import { resolveLoginPath, isLoginPath, type ProductSpec } from "./product-discovery";
import type { Credentials } from "../targets/types";
import Anthropic from "@anthropic-ai/sdk";
import { findBestByRole, roleAffinity } from "./role-match";
import { clickDescribedElement, clickToolHasTarget } from "./click-target";
import { formatToolCallLog, isPasswordLabel, redactFillResultText, REDACTED_SECRET } from "./redact";
import { registerSecret } from "./trace-scrub";
import * as log from "./log";

export interface TestAccount {
  email: string;
  password: string;
  role: string;
  storageStatePath: string;
}

export const ACCOUNTS_RELATIVE_PATH = "test-accounts/accounts.json";

const ACCOUNTS_DIR = path.join(process.cwd(), "test-accounts");
const ACCOUNTS_PATH = path.join(ACCOUNTS_DIR, "accounts.json");

export type AccountsFileInspection = {
  path: string;
  accounts: TestAccount[];
  usableCount: number;
} & (
  | { state: "missing" }
  | { state: "invalid-json"; detail: string }
  | { state: "not-array" }
  | { state: "empty" }
  | { state: "loaded" }
);

export type AccountSetupPlan =
  | {
      action: "run";
      seed: Credentials;
      seedSource: "config" | "accounts.json";
      existing: TestAccount[];
      logs: string[];
    }
  | {
      action: "persist";
      existing: TestAccount[];
      logs: string[];
    }
  | {
      action: "skip";
      existing: TestAccount[];
      logs: string[];
    };

function hasUsableCredentials(account: { email?: string; password?: string }): boolean {
  return typeof account.email === "string" && account.email.trim() !== ""
    && typeof account.password === "string" && account.password !== "";
}

function normalizeAccount(raw: unknown): TestAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.email !== "string") return null;
  if (typeof rec.password !== "string") return null;
  const role = typeof rec.role === "string" && rec.role.trim() !== "" ? rec.role : "user";
  const storageStatePath = typeof rec.storageStatePath === "string" ? rec.storageStatePath : "";
  return { email: rec.email, password: rec.password, role, storageStatePath };
}

export function inspectAccountsFile(): AccountsFileInspection {
  const base = { path: ACCOUNTS_PATH, accounts: [] as TestAccount[], usableCount: 0 };
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    return { ...base, state: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf-8"));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ...base, state: "invalid-json", detail };
  }

  if (!Array.isArray(parsed)) {
    return { ...base, state: "not-array" };
  }

  const accounts = parsed.map(normalizeAccount).filter((a): a is TestAccount => a !== null);
  const usableCount = accounts.filter(hasUsableCredentials).length;
  if (parsed.length === 0 || accounts.length === 0) {
    return { ...base, state: "empty" };
  }
  return { path: ACCOUNTS_PATH, accounts, usableCount, state: "loaded" };
}

export function loadTestAccounts(): TestAccount[] {
  return inspectAccountsFile().accounts;
}

function describeAccountsFile(file: AccountsFileInspection): string {
  const label = ACCOUNTS_RELATIVE_PATH;
  switch (file.state) {
    case "missing":
      return `[account-manager] ${label}: not found`;
    case "invalid-json":
      return `[account-manager] ${label}: found but could not parse (${file.detail})`;
    case "not-array":
      return `[account-manager] ${label}: found but root is not an array`;
    case "empty":
      return `[account-manager] ${label}: found but empty`;
    case "loaded":
      return `[account-manager] ${label}: loaded ${file.accounts.length} account(s) (${file.usableCount} with email+password)`;
    default: {
      const _exhaustive: never = file;
      return `[account-manager] ${label}: unknown state ${String(_exhaustive)}`;
    }
  }
}

export type AuthHandoff =
  | { kind: "session"; email?: string; role?: string }
  | { kind: "credentials"; email: string; password: string; role: string; loginPath: string }
  | { kind: "guest" };

export type BrowserAuthPlan = {
  handoff: AuthHandoff;
  storageStatePath?: string;
  startPath: string;
  roleMismatch?: { requested: string; used: string };
};

/** Join base URL with a login path. `/` and empty path mean the app root. */
export function resolveLoginUrl(baseUrl: string, loginPath?: string): string {
  const trimmed = loginPath?.trim() ?? "";
  if (!trimmed || trimmed === "/") return baseUrl;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = baseUrl.replace(/\/$/, "");
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${base}${path}`;
}

/**
 * URLs to try for Account Manager login, discovered path first.
 * BASE_URL is always last so a marketing homepage does not hide /login.
 */
export function loginCandidateUrls(baseUrl: string, loginPath?: string): string[] {
  const resolved = loginPath ? resolveLoginUrl(baseUrl, loginPath) : undefined;
  const urls: string[] = [];
  if (resolved && resolved.replace(/\/$/, "") !== baseUrl.replace(/\/$/, "")) {
    urls.push(resolved);
  }
  urls.push(baseUrl);
  return urls;
}

function sessionPlan(account: TestAccount, mismatch?: { requested: string; used: string }): BrowserAuthPlan {
  return {
    handoff: { kind: "session", email: account.email, role: account.role },
    storageStatePath: account.storageStatePath,
    startPath: "/",
    ...(mismatch ? { roleMismatch: mismatch } : {}),
  };
}

function defaultSessionAccount(accounts: TestAccount[]): TestAccount | undefined {
  const withSession = accounts.filter((a) => Boolean(a.storageStatePath));
  if (withSession.length === 0) return undefined;
  return findBestByRole(withSession, "user")
    ?? findBestByRole(withSession, "member")
    ?? withSession[0];
}

export function pickAdminAccount(accounts: TestAccount[]): TestAccount | undefined {
  const usable = accounts.filter(hasUsableCredentials);
  return findBestByRole(usable, "admin")
    ?? usable.find((a) => /admin|administrator|管理者/.test(a.role));
}

/**
 * Decide how a browser agent should authenticate.
 *
 * Session injection stays the default. When it failed but accounts.json still
 * has email/password, hand those values over with the discovered login path
 * instead of letting the agent invent credentials. Guest exploration is only
 * for agents that truly have no test account — and they are told not to guess.
 */
export function planBrowserAuth(opts: {
  testAccounts: TestAccount[];
  accountRole: string;
  loginPath?: string;
  returningSessionPath?: string;
  preferAccountSession: boolean;
}): BrowserAuthPlan {
  const sessionForRole = findBestByRole(
    opts.testAccounts.filter((a) => Boolean(a.storageStatePath)),
    opts.accountRole,
  );
  const credsForRole = findBestByRole(
    opts.testAccounts.filter(hasUsableCredentials),
    opts.accountRole,
  );
  const anyCreds = opts.testAccounts.find(hasUsableCredentials);

  if (opts.preferAccountSession && sessionForRole) return sessionPlan(sessionForRole);
  if (opts.returningSessionPath) {
    return { handoff: { kind: "session" }, storageStatePath: opts.returningSessionPath, startPath: "/" };
  }
  if (sessionForRole) return sessionPlan(sessionForRole);

  const fallbackSession = defaultSessionAccount(opts.testAccounts);
  if (fallbackSession) {
    const mismatch = roleAffinity(fallbackSession.role, opts.accountRole) === 0 && Boolean(opts.accountRole?.trim())
      ? { requested: opts.accountRole, used: fallbackSession.role }
      : undefined;
    return sessionPlan(fallbackSession, mismatch);
  }

  const creds = credsForRole ?? anyCreds;
  if (creds) {
    const loginPath = opts.loginPath?.trim() || "/";
    return {
      handoff: {
        kind: "credentials",
        email: creds.email,
        password: creds.password,
        role: creds.role,
        loginPath,
      },
      startPath: loginPath,
    };
  }

  return { handoff: { kind: "guest" }, startPath: "/" };
}

export type DiscoveryStorageState =
  | { status: "ready"; path: string; email?: string }
  | { status: "missing-file"; path: string; email?: string };

/**
 * Session product discovery should open with.
 * Same default as a browser agent with no persona role: a saved user session,
 * then any other saved session. Credential-only accounts stay logged out here;
 * Account Manager signs those in after the spec exists.
 */
export function discoveryStorageState(accounts: TestAccount[]): DiscoveryStorageState | undefined {
  const plan = planBrowserAuth({
    testAccounts: accounts,
    accountRole: "user",
    preferAccountSession: false,
  });
  if (plan.handoff.kind !== "session" || !plan.storageStatePath) return undefined;
  const email = plan.handoff.email;
  if (!fs.existsSync(plan.storageStatePath)) {
    return { status: "missing-file", path: plan.storageStatePath, email };
  }
  return { status: "ready", path: plan.storageStatePath, email };
}

export function authPrompt(handoff: AuthHandoff): string {
  switch (handoff.kind) {
    case "session":
      if (!handoff.email) return "";
      return `
[Authentication]
You are already logged in as ${handoff.email} (${handoff.role ?? "user"}).
Do not log out. Do not submit a login form with different credentials.`;
    case "credentials":
      return `
[Authentication]
You are NOT logged in. Session injection failed, so you must sign in yourself.
Use these exact test credentials — do NOT invent, guess, or try any other username or password:
- Email / username: ${handoff.email}
- Password: ${handoff.password}
- Login page: ${handoff.loginPath}

Navigate to that login page if you are not already there, enter these values, and continue as this user.
If these credentials fail, record that as a finding and continue as a guest. Do not try other credentials.`;
    case "guest":
      return `
[Authentication]
You are exploring as a guest (not logged in).
Do NOT invent, guess, or try usernames and passwords. There are no test credentials available for you.
If you hit a login wall, explore only what is available without an account, or record the login wall as a finding and move on.`;
    default: {
      const _exhaustive: never = handoff;
      return "";
    }
  }
}
