import * as fs from "fs";
import * as path from "path";
import type { Page, BrowserContext } from "playwright";
import type { LLMClient } from "./llm-client";
import { createMessageWithRetry } from "./agent-loop";
import { saveFinding } from "./findings";
import {
  setupObservation,
  getRecentConsoleLogs,
  getRecentNetworkErrors,
  readPageText,
  readAccessibilityTree,
  saveSnapshotBeforeAction,
  getDiffFromSnapshot,
} from "./observation";
import { resolveLoginPath, isLoginPath, type ProductSpec } from "./product-discovery";
import type { Credentials } from "../targets/types";
import Anthropic from "@anthropic-ai/sdk";
import { findBestByRole } from "./role-match";
import { clickDescribedElement } from "./click-target";

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

function sessionPlan(account: TestAccount): BrowserAuthPlan {
  return {
    handoff: { kind: "session", email: account.email, role: account.role },
    storageStatePath: account.storageStatePath,
    startPath: "/",
  };
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
    case "session":
      return plan.handoff.email
        ? `[auth] ${agentName}: session injected (${plan.handoff.email})`
        : `[auth] ${agentName}: restored previous session`;
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
 * Decide whether Account Manager should run.
 * Seed comes from shoal.config `target.credentials` when present, otherwise
 * from the first usable entry in test-accounts/accounts.json.
 */
export function resolveAccountSetup(configCredentials?: Credentials): AccountSetupPlan {
  const file = inspectAccountsFile();
  const logs = [describeAccountsFile(file)];
  const configSeed = configCredentials && hasUsableCredentials(configCredentials) ? configCredentials : undefined;

  if (configSeed) {
    logs.push(`[account-manager] config credentials: present (${configSeed.email})`);
    logs.push(`[account-manager] starting — seed from shoal.config target.credentials (${configSeed.email})`);
    return { action: "run", seed: configSeed, seedSource: "config", existing: file.accounts, logs };
  }

  logs.push("[account-manager] config credentials: not set");

  const usable = file.accounts.filter(hasUsableCredentials);
  if (usable.length > 0) {
    const seed = { email: usable[0].email, password: usable[0].password };
    logs.push(`[account-manager] starting — seed from ${ACCOUNTS_RELATIVE_PATH} (${seed.email})`);
    return { action: "run", seed, seedSource: "accounts.json", existing: file.accounts, logs };
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

async function takeScreenshot(page: Page, label: string): Promise<string> {
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

async function passwordFieldVisible(page: Page): Promise<boolean> {
  return page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
}

async function snapshotLooksLoggedIn(page: Page, submittedFromUrl: string): Promise<boolean> {
  const currentUrl = typeof page.url === "function" ? page.url() : "";
  return loginLooksEstablished({
    currentUrl,
    submittedFromUrl,
    passwordFieldVisible: await passwordFieldVisible(page),
  });
}

async function waitForLoginEstablished(page: Page, submittedFromUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await snapshotLooksLoggedIn(page, submittedFromUrl)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function performLogin(
  page: Page,
  urls: string[],
  credentials: Credentials,
): Promise<boolean> {
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);
      if (!await fillLoginForm(page, credentials)) continue;
      if (await waitForLoginEstablished(page, url)) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
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
      const ok = await performLogin(page, loginUrls, account);
      if (!ok) return "";
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
    description: "Click a button, link, or element on screen. description may be the accessible name or a short phrase from it; optional ref is an accessibility-tree id (e.g. e12).",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        ref: { type: "string", description: "Optional accessibility-tree ref, e.g. e12" },
      },
      required: ["description"],
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
  if (!loggedIn) {
    console.warn("[account-manager] seed login failed — skipping role discovery, still trying known accounts");
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

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: initialScreenshot } },
        { type: "text", text: "You are logged in. Start exploring user management." },
      ],
    },
  ];

  let iterations = 0;
  outer: while (iterations < 12) {
    iterations++;

    const response = await createMessageWithRetry(client, {
      model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: ACCOUNT_MANAGER_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0 || response.stop_reason === "end_turn") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      let resultText = "";
      let screenshot: string | null = null;

      try {
        switch (toolUse.name) {
          case "done": {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Done." });
            break outer;
          }

          case "view_screen": {
            screenshot = await takeScreenshot(page, "view");
            resultText = "Current screen.";
            break;
          }

          case "navigate": {
            const { path: navPath } = toolUse.input as { path?: string };
            if (!navPath) { resultText = "navigate: missing path"; break; }
            await saveSnapshotBeforeAction(page, observation);
            await page.goto(`${baseUrl}${navPath}`, { waitUntil: "networkidle" });
            await page.waitForTimeout(500);
            screenshot = await takeScreenshot(page, `nav_${navPath}`);
            resultText = `Navigated to ${navPath}`;
            break;
          }

          case "click": {
            const { description, ref } = toolUse.input as { description?: string; ref?: string };
            if (!description) { resultText = "click: missing description"; break; }
            await saveSnapshotBeforeAction(page, observation);
            await clickDescribedElement(page, { description, ref }, 4000);
            await page.waitForTimeout(500);
            screenshot = await takeScreenshot(page, `click`);
            resultText = `Clicked: ${description}`;
            break;
          }

          case "fill": {
            const { label, value } = toolUse.input as { label?: string; value?: string };
            if (!label || value === undefined) { resultText = "fill: missing label or value"; break; }
            await saveSnapshotBeforeAction(page, observation);
            const byLabel = page.getByLabel(new RegExp(label, "i"));
            const byPlaceholder = page.getByPlaceholder(new RegExp(label, "i"));
            let filled = false;
            for (const loc of [byLabel, byPlaceholder]) {
              try { await loc.first().fill(value, { timeout: 3000 }); filled = true; break; } catch { /* next */ }
            }
            if (!filled) throw new Error(`No input matching: ${label}`);
            resultText = `Filled "${label}" with "${value}"`;
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
            const { email, password, role } = toolUse.input as { email?: string; password?: string; role?: string };
            if (!email || !password || !role) { resultText = "save_account: missing required fields"; break; }
            savedAccounts.push({ email, password, role });
            console.log(`  [account-manager] saved account: ${email} (role: ${role})`);
            resultText = `Account saved: ${email} (${role})`;
            break;
          }

          case "post_finding": {
            const { title, body } = toolUse.input as { title?: string; body?: string };
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
        }
      } catch (e) {
        resultText = `error: ${String(e)}`;
      }

      const content: Anthropic.ToolResultBlockParam["content"] = screenshot
        ? [
            { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
            { type: "text", text: resultText },
          ]
        : resultText;

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
    }

    messages.push({ role: "user", content: toolResults });
  }

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
  accounts: Array<{ email: string; password: string; role: string }>,
  alreadySaved: Record<string, string> = {},
): Promise<TestAccount[]> {
  const testAccounts: TestAccount[] = [];
  for (const account of accounts) {
    console.log(`  [account-manager] saving session for ${account.email} (role: ${account.role})`);
    const statePath = Object.prototype.hasOwnProperty.call(alreadySaved, account.email)
      ? alreadySaved[account.email]
      : await captureAccountSession(loginUrls, context, account);
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
