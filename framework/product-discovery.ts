import type { LLMClient } from "./llm-client";
import { runToolSession } from "./tool-session";
import { normalizeThresholdCandidates, type ThresholdCandidate } from "./threshold";
import { normalizeProductEdge, type ProductEdge } from "./product-edge";
import type { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";

export type { ThresholdCandidate } from "./threshold";
export type { ProductEdge } from "./product-edge";

// ================================================================
// Documentation gathering (local or GitHub)
// ================================================================

const DOC_CANDIDATES = [
  "README.md", "README_JA.md", "README.ja.md", "README.txt",
  "docs/index.md", "docs/overview.md", "docs/README.md",
  "openapi.json", "openapi.yaml", "swagger.json", "swagger.yaml",
  "package.json",
];
const MAX_DOC_CHARS = 6000;

function readLocalDocs(projectPath: string): string {
  const sections: string[] = [];
  let totalChars = 0;

  for (const candidate of DOC_CANDIDATES) {
    if (totalChars >= MAX_DOC_CHARS) break;
    const filePath = path.join(projectPath, candidate);
    if (!fs.existsSync(filePath)) continue;
    try {
      let content = fs.readFileSync(filePath, "utf-8");
      if (candidate === "package.json") {
        // package.json は name / description / scripts だけ抜く
        const pkg = JSON.parse(content) as Record<string, unknown>;
        content = JSON.stringify({ name: pkg.name, description: pkg.description, scripts: pkg.scripts }, null, 2);
      }
      const remaining = MAX_DOC_CHARS - totalChars;
      const chunk = content.slice(0, remaining);
      sections.push(`### ${candidate}\n${chunk}`);
      totalChars += chunk.length;
      console.log(`  [product-discovery] local doc: ${candidate} (${chunk.length} chars)`);
    } catch {
      // ignore unreadable files
    }
  }

  return sections.join("\n\n");
}

async function fetchGitHubReadme(githubRepo: string): Promise<string> {
  for (const branch of ["main", "master"]) {
    const url = `https://raw.githubusercontent.com/${githubRepo}/${branch}/README.md`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const content = text.slice(0, MAX_DOC_CHARS);
      console.log(`  [product-discovery] GitHub README fetched (${content.length} chars, branch: ${branch})`);
      return `### README.md (GitHub: ${githubRepo})\n${content}`;
    } catch {
      continue;
    }
  }
  return "";
}

async function gatherDocumentation(projectPath?: string): Promise<string> {
  if (projectPath) {
    const docs = readLocalDocs(projectPath);
    if (docs) return docs;
    console.log("  [product-discovery] local docs: nothing found, falling back to GitHub");
  }

  const githubRepo = process.env.GITHUB_REPO ?? "";
  if (githubRepo && githubRepo !== "owner/repo") {
    return fetchGitHubReadme(githubRepo);
  }

  return "";
}

export interface ProductSpec {
  appName: string;
  appDescription: string;
  targetUsers: string;
  features: string;
  designContext: string;
  uiFeatures: string;
  appGoals: string[];
  confidence: "high" | "medium" | "low";
  sources: string[];
  discoveredAt?: string;
  /** Path of the login / sign-in page when one was observed (e.g. `/login`). */
  loginPath?: string;
  /** Inferred boundaries for the threshold agent lane (empty when unknown / cached old specs). */
  thresholdCandidates?: ThresholdCandidate[];
  /** What the product is deliberately sharp about (undefined when nothing was declared or inferred). */
  productEdge?: ProductEdge;
}

const LOGIN_SEGMENT = /^(?:log[-_]?in|sign[-_]?in|sign[-_]?on|logon)$/i;
const AUTH_PREFIX = /^(?:auth|account|accounts|session|sessions|users)$/i;

/** True when a URL pathname looks like a login / sign-in page. */
export function isLoginPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (LOGIN_SEGMENT.test(parts[0])) return true;
  if (parts.length >= 2 && AUTH_PREFIX.test(parts[0]) && LOGIN_SEGMENT.test(parts[1])) return true;
  return false;
}

/** Normalize a login path or absolute URL to a same-origin pathname. */
export function normalizeLoginPath(raw: string, baseUrl: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed, baseUrl);
    const base = new URL(baseUrl);
    if (url.origin !== base.origin) return undefined;
    const pathname = url.pathname || "/";
    return pathname;
  } catch {
    return undefined;
  }
}

/** Pull a login path out of free-form spec text (features, sources, etc.). */
export function inferLoginPathFromText(text: string): string | undefined {
  const matches = text.match(/\/[A-Za-z0-9_./-]*/g) ?? [];
  for (const match of matches) {
    const pathname = match.split("?")[0].split("#")[0];
    if (isLoginPath(pathname)) return pathname;
  }
  return undefined;
}

/**
 * Login path to use for Account Manager / credential handoff.
 * Prefers an explicit `spec.loginPath`, then infers from features/sources
 * (so cached specs from before this field still work when discovery already saw /login).
 */
export function resolveLoginPath(spec: ProductSpec): string | undefined {
  const explicit = spec.loginPath ? spec.loginPath.trim() : "";
  if (explicit && explicit !== "/") {
    if (/^https?:\/\//i.test(explicit)) {
      try {
        const pathname = new URL(explicit).pathname;
        if (pathname && pathname !== "/") return pathname;
      } catch {
        // fall through to slash-prefix
      }
    }
    return explicit.startsWith("/") ? explicit.split("?")[0] : `/${explicit}`;
  }
  const blob = [spec.features, spec.uiFeatures, ...(spec.sources ?? [])].join("\n");
  return inferLoginPathFromText(blob);
}

type LoginDetection = { formPath?: string; linkPath?: string };

/**
 * Observe the current page for a login form or a link to one.
 * Form pages win over mere links — the form is where credentials get typed.
 */
export async function detectLoginPath(page: Page, currentPath: string, baseUrl: string): Promise<LoginDetection> {
  const result: LoginDetection = {};
  try {
    const passwordVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
    if (passwordVisible) {
      result.formPath = currentPath || "/";
    }
  } catch {
    // page mocks / closed pages — skip
  }

  try {
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).getAttribute("href") || "")
    );
    const hrefs = Array.isArray(raw) ? raw : [];
    for (const href of hrefs) {
      const path = normalizeLoginPath(href, baseUrl);
      if (path && isLoginPath(path)) {
        result.linkPath = path;
        break;
      }
    }
  } catch {
    // ignore
  }

  return result;
}

function specCachePath(baseUrl: string): string {
  const host = new URL(baseUrl).host.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(process.cwd(), "product-specs", `${host}.json`);
}

export function loadCachedSpec(baseUrl: string): ProductSpec | null {
  const filePath = specCachePath(baseUrl);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProductSpec;
    const productEdge = normalizeProductEdge(parsed.productEdge);
    return {
      ...parsed,
      thresholdCandidates: normalizeThresholdCandidates(parsed.thresholdCandidates),
      ...(productEdge ? { productEdge } : {}),
    };
  } catch {
    return null;
  }
}

function saveSpec(baseUrl: string, spec: ProductSpec): void {
  const filePath = specCachePath(baseUrl);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf-8");
  console.log(`  [product-discovery] spec saved: ${filePath}`);

  if (spec.uiFeatures) {
    const mdPath = filePath.replace(/\.json$/, "_UI_FEATURES.md");
    const md = `# UI Features — ${spec.appName}\n\n> Auto-generated by product-discovery on ${new Date().toISOString().slice(0, 10)}\n> UI-only interactions invisible from API responses.\n\n${spec.uiFeatures}\n`;
    fs.writeFileSync(mdPath, md, "utf-8");
    console.log(`  [product-discovery] UI_FEATURES saved: ${mdPath}`);
  }
}

function printSpec(spec: ProductSpec): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  app: ${spec.appName}`);
  console.log(`  description: ${spec.appDescription}`);
  console.log(`  users: ${spec.targetUsers}`);
  console.log(`  features:\n${spec.features.split("\n").map((l) => `    ${l}`).join("\n")}`);
  console.log(`  confidence: ${spec.confidence} / sources: ${spec.sources.join(", ")}`);
  if (spec.productEdge) {
    const edge = spec.productEdge;
    console.log(`  product edge (${edge.source}):`);
    for (const item of edge.sharpEdges) console.log(`    sharp: ${item}`);
    for (const item of edge.tradeoffs) console.log(`    trade-off: ${item}`);
  }
  if (spec.loginPath) console.log(`  login: ${spec.loginPath}`);
  const thresholds = spec.thresholdCandidates ?? [];
  if (thresholds.length > 0) {
    console.log(`  thresholds: ${thresholds.length} candidate(s)`);
    for (const t of thresholds.slice(0, 5)) {
      console.log(`    - [${t.kind}/p${t.priority}] ${t.area}: ${t.signal}`);
    }
  }
  console.log(`${"─".repeat(60)}\n`);
}

const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate_and_read",
    description: "Navigate to a path and read page text + ARIA tree / アプリの指定パスに移動しテキストとARIAツリーを取得する",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to observe (e.g. /, /tasks, /purchases)" },
      },
      required: ["path"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch text content from an external URL (README, About page, etc.) / 外部URLのテキストを取得する",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "output_spec",
    description: "Finalize and output the product spec once enough information has been gathered / 十分な情報が集まったらプロダクト仕様を確定して出力する",
    input_schema: {
      type: "object",
      properties: {
        appName: { type: "string", description: "App name" },
        appDescription: { type: "string", description: "What the app does, who it's for, and its main value (2-3 sentences)" },
        targetUsers: { type: "string", description: "Target users: roles, technical level, usage scenarios" },
        features: {
          type: "string",
          description: "What the product does — capabilities and workflows, listed per screen as bullet points. Owns feature inventory (search, filters, sort, badges, forms, etc.). Do NOT put success criteria here; that belongs in appGoals.",
        },
        designContext: {
          type: "string",
          description: "Detected UI framework, visual style, and applicable design standards. Include: (1) UI framework/library if detectable (Tailwind CSS, Material UI, Bootstrap, etc.), (2) visual style (minimalist, corporate, playful, dense, etc.), (3) design conventions relevant to this app type (e.g. enterprise UX patterns, consumer mobile conventions, dashboard best practices). Example: 'Tailwind CSS, minimalist corporate style — enterprise conventions: clear status indicators, inline validation, progressive disclosure for complex forms'",
        },
        uiFeatures: {
          type: "string",
          description: "UI-only interactions and widgets that are NOT visible from API responses alone — search boxes, filters, sort controls, badges on cards, view toggles, modals, validation messages, empty states, etc. List per screen. Format: 'Screen: feature 1 · feature 2 · feature 3'. These belong here (and in features), NEVER in appGoals.",
        },
        loginPath: {
          type: "string",
          description: "Path of the login / sign-in page if you found one (e.g. /login, /signin, /auth/login). Empty string if the app has no login.",
        },
        appGoals: {
          type: "array",
          items: { type: "string" },
          description: "3–6 user/business SUCCESS CONDITIONS (outcomes), not a UI checklist. Each goal is a complete sentence about what a person can achieve — never name widgets or controls. Good: 'New employees can complete the intended purchase request without training', 'Approvers can decide on a request within a minute'. Bad (do NOT write): 'Users can search, filter, and sort requests', 'Cards show status badges', 'There is a filter dropdown'. Put search/filter/sort/badges in features or uiFeatures instead.",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Inference confidence: high if README/docs ground purpose and goals; medium if mixed sources; low if UI observation only (appGoals are draft for human edit in Hall)",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Sources used (e.g. ['/ (top page)', '/tasks (UI)', 'README'])",
        },
        productEdge: {
          type: "object",
          description:
            "What this product is deliberately sharp about, and what it deliberately gives up to stay that way. A draft for the team to correct — infer only from real evidence (README positioning, product copy, an unusual-but-consistent interaction), never from what an app of this type usually does. Leave both arrays empty when the app gives no signal.",
          properties: {
            sharpEdges: {
              type: "array",
              items: { type: "string" },
              description: "0–4 things this product does differently or more strongly than the conventional version of its category, and that look intentional. One sentence each, e.g. 'Every screen is one keyboard flow — no mouse path is provided, on purpose'.",
            },
            tradeoffs: {
              type: "array",
              items: { type: "string" },
              description: "0–4 things it deliberately does NOT do, accepted as a cost of the edges above. e.g. 'No onboarding wizard — the product assumes a trained operator'.",
            },
          },
        },
        thresholdCandidates: {
          type: "array",
          description:
            "Boundaries worth probing (input limits, plan/quota/permission edges, experience degradation). Prefer 8–12 high-signal items; empty array if none are clear. Do not invent quotas you did not see evidence for.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id, e.g. billing-seat-cap" },
              kind: {
                type: "string",
                enum: ["input", "business", "experience"],
                description: "input=form/field limits; business=plan/quota/permission; experience=degradation under load/size/device",
              },
              area: { type: "string", description: "Screen or path hint, e.g. /settings/billing" },
              signal: { type: "string", description: "What the threshold is" },
              howToProbe: { type: "string", description: "How an agent should push against it" },
              priority: {
                type: "integer",
                enum: [1, 2, 3],
                description: "1=highest. Prefer business edges first when unsure",
              },
              expectedBehavior: {
                type: "string",
                description: "Optional: what should happen at the boundary (unused by MVP agents)",
              },
            },
            required: ["id", "kind", "area", "signal", "howToProbe", "priority"],
          },
        },
      },
      required: ["appName", "appDescription", "targetUsers", "features", "designContext", "uiFeatures", "appGoals", "confidence", "sources"],
    },
  },
];

export async function discoverProduct(
  baseUrl: string,
  page: Page,
  client: LLMClient,
  model: string,
  projectPath?: string,
): Promise<ProductSpec> {
  console.log("\n[product-discovery] starting...");

  // 宣言された product edge はチームの判断なので、再ディスカバリの推論で上書きしない
  const cachedEdge = loadCachedSpec(baseUrl)?.productEdge;
  const declaredEdge = cachedEdge?.source === "human" ? cachedEdge : undefined;
  if (declaredEdge) console.log("  [product-discovery] keeping the team-declared product edge");

  const systemPrompt = `You are a product discovery agent.
Observe the given web app and infer what it is.

Steps:
1. Use navigate_and_read to observe the top page
2. Observe 2-3 key screens (follow tabs or navigation)
3. If a README or About page is available, fetch it with fetch_url
4. Once you have enough information, call output_spec (finish within 6 observations)

Field roles (keep these separate — do not duplicate content across them):
- features / uiFeatures: WHAT the product has (capabilities, screens, widgets, controls)
- appGoals: WHETHER users/business succeed (outcome success conditions only)

Guidelines for output_spec:
- appDescription: 2-3 sentences covering who uses it, why, and the main value
- targetUsers: roles, technical level, and usage scenarios (be specific)
- features: list per screen as "Screen name: feature 1 · feature 2 · feature 3" (include search, filters, sort, badges here if present)
- designContext: note the UI framework (look for class names like "tw-", "MuiButton", "btn btn-"), visual style, and what design conventions apply for this app type
- uiFeatures: list UI-only widgets/interactions per screen (filters, sort, badges, toggles, modals, validation, empty states, etc.) — never copy these into appGoals
- loginPath: if you saw a login / sign-in form or a link to one, record that path (e.g. /login)
- confidence: high if README/official docs obtained, medium if mixed, low if UI observation only
- appGoals: 3–6 outcome sentences from user + business perspective. Write results ("can complete X without training"), never widget names ("using search and filter"). Agents use these as goal-gap criteria, so UI checklists create false visual-regression findings.
- productEdge: only when the app itself shows it — a deliberate choice a competitor would call a flaw (sharpEdges) and what it gives up for that (tradeoffs). Omit or leave empty rather than guessing; the team corrects this draft in the dashboard, and triage uses it to flag tickets whose fix would flatten the product
- thresholdCandidates: infer 8–12 (or fewer) probe-worthy boundaries from UI copy, forms (maxlength, required), plan/billing/permission wording, empty/heavy states. Kinds: input | business | experience. priority 1–3 (business edges usually 1). Empty array if unclear — do not invent limits.
- When evidence is UI observation only: set confidence to low; write at most 2–3 high-level outcome drafts (no control names); treat them as Hall-editable drafts, not verified product goals`

  const docs = await gatherDocumentation(projectPath);
  const initialContent = docs
    ? `App URL: ${baseUrl}\n\nInvestigate what this app is.\n\n[Available Documentation]\n${docs}`
    : `App URL: ${baseUrl}\n\nInvestigate what this app is.`;

  let spec: ProductSpec | null = null;
  let observedFormPath: string | undefined;
  let observedLinkPath: string | undefined;

  const sessionTools = DISCOVERY_TOOLS.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: t.input_schema as Record<string, unknown>,
    execute: async (input: Record<string, unknown>): Promise<string> => {
      if (t.name === "navigate_and_read") {
        const pathArg = input.path as string | undefined;
        if (!pathArg) return "navigate_and_read: missing path";
        try {
          await page.goto(`${baseUrl}${pathArg}`, { waitUntil: "load", timeout: 10000 });
          await page.waitForTimeout(500);
          const [text, aria] = await Promise.all([
            page.evaluate(() => document.body.innerText.slice(0, 1500)),
            page.ariaSnapshot({ mode: "ai", depth: 5 }).then((s) => s.slice(0, 1500)),
          ]);
          console.log(`  [product-discovery] observed: ${pathArg}`);
          const detected = await detectLoginPath(page, pathArg, baseUrl);
          if (detected.formPath && !observedFormPath) {
            observedFormPath = detected.formPath;
            console.log(`  [product-discovery] login form at: ${observedFormPath}`);
          }
          if (detected.linkPath && !observedLinkPath) {
            observedLinkPath = detected.linkPath;
            console.log(`  [product-discovery] login link: ${observedLinkPath}`);
          }
          return `[${pathArg} text]\n${text}\n\n[ARIA tree]\n${aria}`;
        } catch (e) {
          return `fetch failed: ${String(e)}`;
        }
      }
      if (t.name === "fetch_url") {
        const url = input.url as string | undefined;
        if (!url) return "fetch_url: missing url";
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const text = await res.text();
          console.log(`  [product-discovery] fetched: ${url}`);
          return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
        } catch (e) {
          return `fetch failed: ${String(e)}`;
        }
      }
      if (t.name === "output_spec") {
        const fromLlm = typeof input.loginPath === "string"
          ? normalizeLoginPath(input.loginPath as string, baseUrl)
          : undefined;
        const loginPath = observedFormPath
          ?? (fromLlm && fromLlm !== "/" ? fromLlm : undefined)
          ?? observedLinkPath;
        const thresholdCandidates = normalizeThresholdCandidates(input.thresholdCandidates);
        const productEdge = declaredEdge ?? normalizeProductEdge(input.productEdge);
        spec = {
          appName: String(input.appName),
          appDescription: String(input.appDescription),
          targetUsers: String(input.targetUsers),
          features: String(input.features),
          designContext: String(input.designContext ?? ""),
          uiFeatures: String(input.uiFeatures ?? ""),
          appGoals: Array.isArray(input.appGoals) ? input.appGoals.map(String) : [],
          confidence: input.confidence as ProductSpec["confidence"],
          sources: Array.isArray(input.sources) ? input.sources.map(String) : [],
          thresholdCandidates,
          ...(productEdge ? { productEdge } : {}),
          ...(loginPath ? { loginPath } : {}),
        };
        console.log(`  [product-discovery] spec confirmed (confidence: ${spec.confidence})`);
        return "product spec finalized";
      }
      return "unknown tool";
    },
  }));

  await runToolSession({
    provider: process.env.LLM_PROVIDER ?? "anthropic",
    client,
    model,
    system: systemPrompt,
    userPrompt: initialContent,
    tools: sessionTools,
    maxIterations: 8,
    maxTokens: 2048,
    shouldStop: ({ toolUses }) => toolUses.some((tu) => tu.name === "output_spec"),
  });

  if (!spec) {
    console.log("  [product-discovery] spec not confirmed, using fallback");
    const loginPath = observedFormPath ?? observedLinkPath;
    spec = {
      appName: new URL(baseUrl).hostname,
      appDescription: "(auto-discovery failed)",
      targetUsers: "(unknown)",
      features: "(auto-discovery failed)",
      designContext: "(unknown)",
      uiFeatures: "(unknown)",
      appGoals: [],
      confidence: "low",
      sources: [],
      thresholdCandidates: [],
      ...(declaredEdge ? { productEdge: declaredEdge } : {}),
      ...(loginPath ? { loginPath } : {}),
    };
  }

  spec.discoveredAt = new Date().toISOString();
  saveSpec(baseUrl, spec);
  console.log(`[product-discovery] done: "${spec.appName}" (confidence: ${spec.confidence})`);
  printSpec(spec);
  return spec;
}
