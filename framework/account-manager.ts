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
import type { ProductSpec } from "./product-discovery";
import type { Credentials } from "../targets/types";
import Anthropic from "@anthropic-ai/sdk";

export interface TestAccount {
  email: string;
  password: string;
  role: string;
  storageStatePath: string;
}

const ACCOUNTS_DIR = path.join(process.cwd(), "test-accounts");
const ACCOUNTS_PATH = path.join(ACCOUNTS_DIR, "accounts.json");

export function loadTestAccounts(): TestAccount[] {
  try {
    if (fs.existsSync(ACCOUNTS_PATH)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf-8")) as TestAccount[];
    }
  } catch { /* ignore */ }
  return [];
}

function saveTestAccounts(accounts: TestAccount[]): void {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), "utf-8");
}

// ================================================================
// Playwright helpers (shared with browser agent but local here)
// ================================================================

async function takeScreenshot(page: Page, label: string): Promise<string> {
  const buffer = await page.screenshot({ type: "png", fullPage: false });
  return buffer.toString("base64");
}

async function performLogin(
  page: Page,
  baseUrl: string,
  credentials: Credentials,
): Promise<boolean> {
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // email / username フィールドを探す
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

    // password フィールド
    const passEl = page.locator('input[type="password"]').first();
    if (!await passEl.isVisible({ timeout: 2000 }).catch(() => false)) return false;
    await passEl.fill(credentials.password);

    // submit
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
  } catch {
    return false;
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
    description: "Click a button, link, or element on screen.",
    input_schema: {
      type: "object",
      properties: { description: { type: "string" } },
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
    description: "Get the page accessibility tree.",
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
): Promise<TestAccount[]> {
  console.log("\n[account-manager] starting...");

  const page = await context.newPage();
  const observation = setupObservation(page);

  // まず seed アカウントでログイン
  console.log(`[account-manager] logging in as ${credentials.email}...`);
  const loggedIn = await performLogin(page, baseUrl, credentials);
  if (!loggedIn) {
    console.warn("[account-manager] login failed — skipping account setup");
    await page.close();
    return [];
  }
  console.log("[account-manager] login succeeded");

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
            const { description } = toolUse.input as { description?: string };
            if (!description) { resultText = "click: missing description"; break; }
            await saveSnapshotBeforeAction(page, observation);
            const escaped = description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            let clicked = false;
            for (const loc of [
              page.getByRole("button", { name: new RegExp(escaped, "i") }),
              page.getByRole("link", { name: new RegExp(escaped, "i") }),
              page.getByText(description, { exact: false }),
            ]) {
              try { await loc.first().click({ timeout: 4000 }); clicked = true; break; } catch { /* next */ }
            }
            if (!clicked) throw new Error(`No element matching: ${description}`);
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
  console.log(`[account-manager] found ${savedAccounts.length} account(s)`);

  if (savedAccounts.length === 0) return [];

  // 各アカウントにログインして storageState を保存
  const testAccounts: TestAccount[] = [];
  for (const account of savedAccounts) {
    const stateDir = path.join(ACCOUNTS_DIR, "states");
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, `${account.role.replace(/[^a-zA-Z0-9]/g, "_")}.json`);

    console.log(`  [account-manager] saving session for role: ${account.role}`);
    const loginPage = await context.newPage();
    const ok = await performLogin(loginPage, baseUrl, account);
    if (ok) {
      await context.storageState({ path: statePath });
      console.log(`    saved: ${statePath}`);
    } else {
      console.warn(`    login failed for ${account.email} — storageState not saved`);
    }
    await loginPage.close();

    testAccounts.push({ ...account, storageStatePath: ok ? statePath : "" });
  }

  saveTestAccounts(testAccounts);
  console.log(`[account-manager] done (${testAccounts.length} account(s) ready)`);
  return testAccounts;
}
