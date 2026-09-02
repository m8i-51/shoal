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

export function describeAuthPlan(agentName: string, plan: BrowserAuthPlan): string {
  switch (plan.handoff.kind) {
    case "session": {
      const mismatch = plan.roleMismatch
        ? ` — role mismatch: persona "${plan.roleMismatch.requested}" vs account "${plan.roleMismatch.used}"`
        : "";
      return plan.handoff.email
        ? `[auth] ${agentName}: session injected (${plan.handoff.email})${mismatch}`
        : `[auth] ${agentName}: restored previous session`;
    }
    case "credentials":
      return `[auth] ${agentName}: no session — handing off credentials for ${plan.handoff.email} at ${plan.handoff.loginPath}`;
    case "guest":
      return `[auth] ${agentName}: guest (do not guess credentials)`;
    default: {
      const _exhaustive: never = plan.handoff;
      return `[auth] ${agentName}: unknown`;
    }
  }
}

function pageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}`;
  } catch {
    return url.replace(/\/+$/, "") || "/";
  }
}

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

/** True when the page looks logged in — left the login URL, or the login form is gone. */
export function loginLooksEstablished(input: {
  currentUrl: string;
  submittedFromUrl: string;
  passwordFieldVisible: boolean;
}): boolean {
  const samePage = pageIdentity(input.currentUrl) === pageIdentity(input.submittedFromUrl);
  const currentIsLogin = isLoginPath(urlPathname(input.currentUrl));

  if (input.passwordFieldVisible && (samePage || currentIsLogin)) return false;
  if (!samePage && !currentIsLogin) return true;
  return !input.passwordFieldVisible;
}

export type LoginAttempt = {
  ok: boolean;
  triedUrls: string[];
  lastUrl?: string;
  passwordFieldVisible?: boolean;
  formFilled?: boolean;
};

export function describeLoginFailure(attempt: LoginAttempt): string {
  if (attempt.ok) return "ok";
  if (!attempt.formFilled) {
    const where = attempt.lastUrl ? ` (last URL: ${attempt.lastUrl})` : "";
    return `login form not found or not filled${where}`;
  }
  const parts: string[] = [];
  if (attempt.lastUrl) {
    if (isLoginPath(urlPathname(attempt.lastUrl))) {
      parts.push(`still on login URL (${attempt.lastUrl})`);
    } else {
      parts.push(`still at ${attempt.lastUrl}`);
    }
  }
  if (attempt.passwordFieldVisible) parts.push("password field still visible");
  return parts.join("; ") || "login did not establish a session";
}

/** Playwright storageState is only useful if it actually captured cookies or localStorage. */
export function storageStateHasSession(state: {
  cookies?: Array<unknown>;
  origins?: Array<{ localStorage?: Array<unknown> }>;
}): boolean {
  if ((state.cookies?.length ?? 0) > 0) return true;
  return (state.origins ?? []).some((origin) => (origin.localStorage?.length ?? 0) > 0);
}

function skipReason(file: AccountsFileInspection): string {
  switch (file.state) {
    case "missing":
      return `no ${ACCOUNTS_RELATIVE_PATH} and no target.credentials in shoal.config.ts`;
    case "invalid-json":
      return `${ACCOUNTS_RELATIVE_PATH} is not valid JSON and no target.credentials in shoal.config.ts`;
    case "not-array":
      return `${ACCOUNTS_RELATIVE_PATH} must be a JSON array and no target.credentials in shoal.config.ts`;
    case "empty":
      return `${ACCOUNTS_RELATIVE_PATH} is empty and no target.credentials in shoal.config.ts`;
    case "loaded":
      return `${ACCOUNTS_RELATIVE_PATH} has ${file.accounts.length} account(s) but none have email and password, and no target.credentials in shoal.config.ts`;
    default: {
      const _exhaustive: never = file;
      return `no seed credentials (${String(_exhaustive)})`;
    }
  }
}

/**
 * Decide whether Account Manager should run LLM exploration or only persist sessions.
 * When accounts.json already has usable accounts, skip admin UI exploration.
 */
export function resolveAccountSetup(configCredentials?: Credentials): AccountSetupPlan {
  const file = inspectAccountsFile();
  const logs = [describeAccountsFile(file)];
  const configSeed = configCredentials && hasUsableCredentials(configCredentials) ? configCredentials : undefined;
  const usable = file.accounts.filter(hasUsableCredentials);

  if (configSeed) {
    logs.push(`[account-manager] config credentials: present (${configSeed.email})`);
  } else {
    logs.push("[account-manager] config credentials: not set");
  }

  if (usable.length > 0) {
    logs.push(`[account-manager] accounts already present — capturing sessions only, skipping admin UI exploration`);
    return { action: "persist", existing: file.accounts, logs };
  }

  if (configSeed) {
    const admin = pickAdminAccount(file.accounts);
    const seed = admin ? { email: admin.email, password: admin.password } : configSeed;
    const seedSource: "config" | "accounts.json" = admin ? "accounts.json" : "config";
    logs.push(`[account-manager] starting — seed from ${seedSource === "config" ? "shoal.config target.credentials" : ACCOUNTS_RELATIVE_PATH} (${seed.email})`);
    return { action: "run", seed, seedSource, existing: file.accounts, logs };
  }

  logs.push(`[account-manager] skipped — ${skipReason(file)}`);
  const reusable = file.accounts.filter((a) => a.storageStatePath);
  if (reusable.length > 0) {
    logs.push(`[account-manager] ${reusable.length} saved session(s) in ${ACCOUNTS_RELATIVE_PATH} will still be applied`);
  }
  return { action: "skip", existing: file.accounts, logs };
}

function saveTestAccounts(accounts: TestAccount[]): void {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), "utf-8");
}

function collectAccountsToPersist(
  seed: Credentials,
  existing: TestAccount[],
  created: Array<{ email: string; password: string; role: string }>,
): Array<{ email: string; password: string; role: string }> {
  const byEmail = new Map<string, { email: string; password: string; role: string }>();
  const seedRole = existing.find((a) => a.email === seed.email)?.role || "user";
  byEmail.set(seed.email, { email: seed.email, password: seed.password, role: seedRole });
  for (const account of existing) {
    if (!hasUsableCredentials(account)) continue;
    byEmail.set(account.email, { email: account.email, password: account.password, role: account.role || "user" });
  }
  for (const account of created) {
    byEmail.set(account.email, account);
  }
  return [...byEmail.values()];
}

// ================================================================
// Playwright helpers (shared with browser agent but local here)
// ================================================================

// `label` is unused here but kept so call sites read as documentation.
async function takeScreenshot(page: Page, _label: string): Promise<string> {
  const buffer = await page.screenshot({ type: "png", fullPage: false });
  return buffer.toString("base64");
}

async function fillLoginForm(page: Page, credentials: Credentials): Promise<boolean> {
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="user" i]',
  ];
  let filled = false;
  for (const sel of emailSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.fill(credentials.email);
      filled = true;
      break;
    }
  }
  if (!filled) return false;

  const passEl = page.locator('input[type="password"]').first();
  if (!await passEl.isVisible({ timeout: 2000 }).catch(() => false)) return false;
  await passEl.fill(credentials.password);

  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("ログイン")',
    'button:has-text("サインイン")',
  ];
  for (const sel of submitSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click();
      await page.waitForTimeout(2000);
      return true;
    }
  }
  return false;
}

async function isPasswordFieldVisible(page: Page): Promise<boolean> {
  return page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
}

async function snapshotLooksLoggedIn(page: Page, submittedFromUrl: string): Promise<boolean> {
  const currentUrl = typeof page.url === "function" ? page.url() : "";
  return loginLooksEstablished({
    currentUrl,
    submittedFromUrl,
    passwordFieldVisible: await isPasswordFieldVisible(page),
  });
}

async function waitForLoginEstablished(page: Page, submittedFromUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await snapshotLooksLoggedIn(page, submittedFromUrl)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function currentPageUrl(page: Page, fallback: string): Promise<string> {
  return typeof page.url === "function" ? page.url() : fallback;
}

async function performLogin(
  page: Page,
  urls: string[],
  credentials: Credentials,
): Promise<LoginAttempt> {
  const triedUrls: string[] = [];
  let lastUrl: string | undefined;
  let formFilled = false;
  let passwordVisible = false;

  for (const url of urls) {
    triedUrls.push(url);
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);
      lastUrl = await currentPageUrl(page, url);
      if (!await fillLoginForm(page, credentials)) continue;
      formFilled = true;
      lastUrl = await currentPageUrl(page, url);
      passwordVisible = await isPasswordFieldVisible(page);
      if (await waitForLoginEstablished(page, url)) {
        return {
          ok: true,
          triedUrls,
          lastUrl: await currentPageUrl(page, url),
          formFilled: true,
          passwordFieldVisible: false,
        };
      }
      lastUrl = await currentPageUrl(page, url);
      passwordVisible = await isPasswordFieldVisible(page);
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, triedUrls, lastUrl, formFilled, passwordFieldVisible: passwordVisible };
}

function sessionStatePath(role: string): string {
  const stateDir = path.join(ACCOUNTS_DIR, "states");
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, `${role.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
}

async function saveContextSession(context: BrowserContext, role: string): Promise<string> {
  const statePath = sessionStatePath(role);
  try {
    const state = await context.storageState({ path: statePath });
    if (!storageStateHasSession(state)) return "";
    return statePath;
  } catch {
    return "";
  }
}

async function captureAccountSession(
  loginUrls: string[],
  parentContext: BrowserContext,
  account: { email: string; password: string; role: string },
): Promise<string> {
  const browser = typeof parentContext.browser === "function" ? parentContext.browser() : null;
  if (!browser || typeof browser.newContext !== "function") return "";

  const isolated = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  try {
    const page = await isolated.newPage();
    try {
      const attempt = await performLogin(page, loginUrls, account);
      if (!attempt.ok) {
        console.warn(`    login failed for ${account.email}: ${describeLoginFailure(attempt)}`);
        return "";
      }
      return await saveContextSession(isolated, account.role);
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch {
    return "";
  } finally {
    await isolated.close().catch(() => undefined);
  }
}

// ================================================================
// Account Manager tools
// ================================================================

const ACCOUNT_MANAGER_TOOLS: Anthropic.Tool[] = [
  {
    name: "view_screen",
    description: "Capture the current screen.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "navigate",
    description: "Navigate to a path.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "click",
    description: "Click a button, link, or element on screen. Prefer the accessible name and/or ref from read_accessibility_tree (e.g. e12). description is optional when ref is set.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Accessible name or a short phrase from it. Optional when ref is set." },
        ref: { type: "string", description: "Optional accessibility-tree ref, e.g. e12" },
      },
      required: [],
    },
  },
  {
    name: "fill",
    description: "Type text into an input field.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string" },
        value: { type: "string" },
      },
      required: ["label", "value"],
    },
  },
  {
    name: "read_page_text",
    description: "Get all visible text on the page.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_accessibility_tree",
    description: "Get the page accessibility tree (includes [ref=eN] ids you can pass to click).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_account",
    description: "Save a test account you successfully created. Call this once per account.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email address of the new account" },
        password: { type: "string", description: "Password of the new account" },
        role: { type: "string", description: "Role or permission level (e.g. admin, member, viewer)" },
      },
      required: ["email", "password", "role"],
    },
  },
  {
    name: "post_finding",
    description: "Record a UX issue you encountered while navigating user management.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "done",
    description: "Signal that account setup is complete.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

// ================================================================
// Main
// ================================================================

export async function runAccountManager(
  baseUrl: string,
  credentials: Credentials,
  productSpec: ProductSpec,
  context: BrowserContext,
  client: LLMClient,
  model: string,
  runId: string,
  existingAccounts: TestAccount[] = [],
): Promise<TestAccount[]> {
  console.log("\n[account-manager] starting...");

  const loginPath = resolveLoginPath(productSpec);
  const loginUrls = loginCandidateUrls(baseUrl, loginPath);
  if (loginPath) {
    console.log(`[account-manager] login URL candidates: ${loginUrls.join(" → ")}`);
  }

  const page = await context.newPage();
  const observation = setupObservation(page);

  // まず seed アカウントでログイン（発見済みのログイン URL を優先）
  console.log(`[account-manager] logging in as ${credentials.email}...`);
  const loggedIn = await performLogin(page, loginUrls, credentials);
  if (!loggedIn.ok) {
    console.warn(`[account-manager] seed login failed (${describeLoginFailure(loggedIn)}) — skipping role discovery, still trying known accounts`);
    await page.close();
    return persistKnownAccounts(
      loginUrls,
      context,
      collectAccountsToPersist(credentials, existingAccounts, []),
      { [credentials.email]: "" },
    );
  }
  console.log("[account-manager] login succeeded");

  const seedRole = existingAccounts.find((a) => a.email === credentials.email)?.role || "user";
  const seedStatePath = await saveContextSession(context, seedRole);

  const initialScreenshot = await takeScreenshot(page, "initial");
  const savedAccounts: Omit<TestAccount, "storageStatePath">[] = [];

  const systemPrompt = `You are the Account Manager for "${productSpec.appName}".
You are already logged in as the seed account (${credentials.email}).

Your job:
1. Explore the app to find user management features (settings, admin panel, user list, invite, etc.)
2. Identify what roles or permission levels exist (e.g. admin, member, viewer, manager)
3. Create one test account per role you find — use realistic-looking test emails like test-admin@example.com
4. Use save_account to record each account you successfully create
5. If you encounter confusing, broken, or hard-to-find UI during this process, use post_finding to record it as a UX issue
6. When done (or after 10 actions), call done

[App Overview]
${productSpec.appDescription}

[Known Features]
${productSpec.features}

If user management is not accessible from this account, or the app has no role system, just call done immediately.`;

  const withScreenshot = (resultText: string, screenshot: string | null): ToolResultContent =>
    screenshot
      ? [
          { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
          { type: "text", text: resultText },
        ]
      : resultText;

  const sessionTools = ACCOUNT_MANAGER_TOOLS.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: t.input_schema as Record<string, unknown>,
    execute: async (input: Record<string, unknown>): Promise<ToolResultContent> => {
      console.log(`  → ${formatToolCallLog(t.name, input)}`);
      let resultText = "";
      let screenshot: string | null = null;

      try {
        switch (t.name) {
          case "done":
            return "Done.";

          case "view_screen": {
            screenshot = await takeScreenshot(page, "view");
            resultText = "Current screen.";
            break;
          }

          case "navigate": {
            const navPath = input.path as string | undefined;
            if (!navPath) { resultText = "navigate: missing path"; break; }
            await saveSnapshotBeforeAction(page, observation);
            await page.goto(`${baseUrl}${navPath}`, { waitUntil: "networkidle" });
            await page.waitForTimeout(500);
            screenshot = await takeScreenshot(page, `nav_${navPath}`);
            resultText = `Navigated to ${navPath}`;
            break;
          }

          case "click": {
            const description = input.description as string | undefined;
            const ref = input.ref as string | undefined;
            if (!clickToolHasTarget({ description, ref })) {
              resultText = "click: missing description or ref";
              break;
            }
            await saveSnapshotBeforeAction(page, observation);
            await clickDescribedElement(page, { description, ref }, 4000);
            await page.waitForTimeout(500);
            screenshot = await takeScreenshot(page, `click`);
            resultText = `Clicked: ${description ?? ref}`;
            break;
          }

          case "fill": {
            const label = input.label as string | undefined;
            const value = input.value as string | undefined;
            if (!label || value === undefined) { resultText = "fill: missing label or value"; break; }
            await saveSnapshotBeforeAction(page, observation);
            const byLabel = page.getByLabel(new RegExp(label, "i"));
            const byPlaceholder = page.getByPlaceholder(new RegExp(label, "i"));
            let filled = false;
            let passwordField = isPasswordLabel(label);
            for (const loc of [byLabel, byPlaceholder]) {
              try {
                const target = loc.first();
                await target.fill(value, { timeout: 3000 });
                filled = true;
                const typeAttr = await target.getAttribute("type").catch(() => null);
                if (typeAttr === "password") passwordField = true;
                break;
              } catch { /* next */ }
            }
            if (!filled) throw new Error(`No input matching: ${label}`);
            if (passwordField) input.value = REDACTED_SECRET;
            resultText = redactFillResultText(label, value, passwordField);
            break;
          }

          case "read_page_text": {
            resultText = await readPageText(page);
            break;
          }

          case "read_accessibility_tree": {
            resultText = await readAccessibilityTree(page);
            break;
          }

          case "save_account": {
            const email = input.email as string | undefined;
            const password = input.password as string | undefined;
            const role = input.role as string | undefined;
            if (!email || !password || !role) { resultText = "save_account: missing required fields"; break; }
            savedAccounts.push({ email, password, role });
            console.log(`  [account-manager] saved account: ${email} (role: ${role})`);
            resultText = `Account saved: ${email} (${role})`;
            break;
          }

          case "post_finding": {
            const title = input.title as string | undefined;
            const body = input.body as string | undefined;
            if (!title || !body) { resultText = "post_finding: missing title or body"; break; }
            saveFinding({
              id: `acct_${Date.now()}`,
              runId,
              agentId: "account-manager",
              agentName: "Account Manager",
              role: "setup",
              title,
              body,
              category: "ux",
              timestamp: new Date().toISOString(),
            });
            console.log(`  [account-manager] finding: ${title}`);
            resultText = "Finding recorded.";
            break;
          }

          default:
            resultText = `Unknown tool: ${t.name}`;
        }
      } catch (e) {
        resultText = `error: ${String(e)}`;
      }

      return withScreenshot(resultText, screenshot);
    },
  }));

  await runToolSession({
    provider: process.env.LLM_PROVIDER ?? "anthropic",
    client,
    model,
    system: systemPrompt,
    userPrompt: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: initialScreenshot } },
      { type: "text", text: "You are logged in. Start exploring user management." },
    ],
    tools: sessionTools,
    maxIterations: 12,
    maxTokens: 1024,
    shouldStop: ({ toolUses }) => toolUses.some((tu) => tu.name === "done"),
  });

  await page.close();
  console.log(`[account-manager] found ${savedAccounts.length} newly created account(s)`);

  return persistKnownAccounts(
    loginUrls,
    context,
    collectAccountsToPersist(credentials, existingAccounts, savedAccounts),
    { [credentials.email]: seedStatePath },
  );
}

async function persistKnownAccounts(
  loginUrls: string[],
  context: BrowserContext,
  accounts: Array<{ email: string; password: string; role: string; storageStatePath?: string }>,
  alreadySaved: Record<string, string> = {},
): Promise<TestAccount[]> {
  const testAccounts: TestAccount[] = [];
  for (const account of accounts) {
    console.log(`  [account-manager] saving session for ${account.email} (role: ${account.role})`);
    let statePath = Object.prototype.hasOwnProperty.call(alreadySaved, account.email)
      ? alreadySaved[account.email]
      : await captureAccountSession(loginUrls, context, account);
    if (!statePath && account.storageStatePath) {
      statePath = account.storageStatePath;
      console.warn(`    login failed for ${account.email} — keeping previously saved session`);
    }
    if (statePath) {
      console.log(`    saved: ${statePath}`);
    } else {
      console.warn(`    login failed for ${account.email} — storageState not saved; credentials kept for browser-agent handoff`);
    }
    testAccounts.push({ ...account, storageStatePath: statePath });
  }

  saveTestAccounts(testAccounts);
  const ready = testAccounts.filter((a) => a.storageStatePath);
  const fallback = testAccounts.filter((a) => !a.storageStatePath && hasUsableCredentials(a));
  console.log(`[account-manager] done (${ready.length}/${testAccounts.length} account(s) with session)`);
  if (fallback.length > 0) {
    console.warn(`[account-manager] ${fallback.length} account(s) have no session — browser agents will receive credentials and the login URL instead of guessing`);
  }
  // Keep accounts without a session so the runner can hand off credentials
  // instead of leaving browser agents to invent logins.
  return testAccounts;
}

/** Refresh storageState for accounts that already exist — no admin-UI exploration. */
export async function persistAccountSessions(
  baseUrl: string,
  loginPath: string | undefined,
  context: BrowserContext,
  accounts: TestAccount[],
): Promise<TestAccount[]> {
  const loginUrls = loginCandidateUrls(baseUrl, loginPath);
  console.log("[account-manager] capturing sessions for existing accounts (no admin UI exploration)");
  const usable = accounts.filter(hasUsableCredentials);
  return persistKnownAccounts(loginUrls, context, usable, {});
}
