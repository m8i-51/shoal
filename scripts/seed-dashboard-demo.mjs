/**
 * Temporary seed for capturing README dashboard screenshots.
 * Writes into gitignored paths (logs/, findings/, coverage/, product-specs/, agents.json).
 * Findings mirror the known bugs in bench/labels.json against the local bench store.
 */
import * as fs from "fs";
import * as path from "path";

const root = process.cwd();
const BASE = "http://localhost:3456";
const hostKey = "localhost-3456";

function agent(partial) {
  return {
    agentType: "browser",
    agentId: partial.agentId,
    agentName: partial.agentName,
    role: partial.role,
    startedAt: partial.startedAt,
    completedAt: partial.completedAt,
    status: "completed",
    iterations: partial.iterations ?? 8,
    actions: [],
    visitedPaths: partial.visitedPaths ?? ["/", "/items", "/cart"],
    issuesPosted: [],
    regressionChecks: [],
    error: null,
    ...partial,
  };
}

function runLog({ runId, startedAt, completedAt, agents, cost }) {
  return {
    runId,
    startedAt,
    completedAt,
    repo: "bench-store",
    agents,
    summary: {
      totalAgents: agents.length,
      completed: agents.length,
      errors: 0,
      iterationLimitReached: 0,
      totalActions: agents.reduce((s, a) => s + (a.iterations ?? 0), 0),
      totalIssuesPosted: 0,
      regressionChecked: 0,
      regressionFailed: 0,
      rateLimitRetries: 0,
      cost,
    },
  };
}

function finding(f) {
  return {
    id: f.id,
    runId: f.runId,
    agentId: f.agentId,
    agentName: f.agentName,
    role: f.role,
    title: f.title,
    body: f.body,
    category: f.category,
    timestamp: f.timestamp,
  };
}

const runs = [
  {
    runId: "run_1756800000001",
    startedAt: "2026-08-28T10:00:00.000Z",
    completedAt: "2026-08-28T10:18:00.000Z",
    cost: { inputTokens: 420000, outputTokens: 68000, estimatedUSD: 2.14 },
    agents: [
      agent({
        agentId: "a1",
        agentName: "Maya Chen",
        role: "accessibility auditor",
        startedAt: "2026-08-28T10:00:30.000Z",
        completedAt: "2026-08-28T10:12:00.000Z",
        visitedPaths: ["/", "/items"],
      }),
      agent({
        agentId: "a2",
        agentName: "Jordan Blake",
        role: "first-time shopper",
        startedAt: "2026-08-28T10:00:30.000Z",
        completedAt: "2026-08-28T10:16:00.000Z",
        visitedPaths: ["/", "/items", "/cart", "/help"],
      }),
      agent({
        agentId: "a3",
        agentName: "Sam Okada",
        role: "security-minded admin",
        startedAt: "2026-08-28T10:01:00.000Z",
        completedAt: "2026-08-28T10:17:00.000Z",
        visitedPaths: ["/", "/admin", "/items"],
        agentType: "threshold",
      }),
    ],
    findings: [
      {
        id: "f1",
        title: "Buy button text is nearly invisible against its background",
        body: "On the home page the featured Buy button uses a light gray label (#e0e0e0) on a near-white background (#f4f4f4). I could barely tell it was a button until I hovered. Screen-magnifier users and anyone outdoors will miss the CTA.",
        category: "ux",
        agentId: "a1",
        agentName: "Maya Chen",
        role: "accessibility auditor",
        timestamp: "2026-08-28T10:08:00.000Z",
      },
      {
        id: "f2",
        title: "Home page product image has no alt text",
        body: "The logo/product image on / has an empty or missing alt attribute. A screen reader announces nothing useful — just \"image\". For a storefront that is the first visual, this is a basic a11y miss.",
        category: "ux",
        agentId: "a1",
        agentName: "Maya Chen",
        role: "accessibility auditor",
        timestamp: "2026-08-28T10:09:30.000Z",
      },
      {
        id: "f3",
        title: "Help nav link returns 404",
        body: "I clicked Help in the top nav expecting docs or support. The page is a 404. For a first-time shopper this feels like the product is unfinished.",
        category: "bug",
        agentId: "a2",
        agentName: "Jordan Blake",
        role: "first-time shopper",
        timestamp: "2026-08-28T10:11:00.000Z",
      },
      {
        id: "f4",
        title: "/admin is reachable with no authentication",
        body: "Opening /admin directly shows administrative controls with no login wall. Anyone who knows the URL can reach destructive actions. This should require auth before rendering anything sensitive.",
        category: "bug",
        agentId: "a3",
        agentName: "Sam Okada",
        role: "security-minded admin",
        timestamp: "2026-08-28T10:14:00.000Z",
      },
    ],
  },
  {
    runId: "run_1756900000002",
    startedAt: "2026-08-30T14:00:00.000Z",
    completedAt: "2026-08-30T14:22:00.000Z",
    cost: { inputTokens: 510000, outputTokens: 79000, estimatedUSD: 2.61 },
    agents: [
      agent({
        agentId: "b1",
        agentName: "Jordan Blake",
        role: "first-time shopper",
        startedAt: "2026-08-30T14:00:20.000Z",
        completedAt: "2026-08-30T14:18:00.000Z",
        visitedPaths: ["/", "/items", "/cart"],
      }),
      agent({
        agentId: "b2",
        agentName: "Riley Park",
        role: "inventory clerk",
        startedAt: "2026-08-30T14:00:20.000Z",
        completedAt: "2026-08-30T14:20:00.000Z",
        visitedPaths: ["/items", "/cart", "/admin"],
      }),
      agent({
        agentId: "b3",
        agentName: "Maya Chen",
        role: "accessibility auditor",
        startedAt: "2026-08-30T14:01:00.000Z",
        completedAt: "2026-08-30T14:15:00.000Z",
      }),
      agent({
        agentId: "b4",
        agentName: "Alex Rivera",
        role: "power buyer",
        startedAt: "2026-08-30T14:01:00.000Z",
        completedAt: "2026-08-30T14:21:00.000Z",
        visitedPaths: ["/", "/items", "/cart"],
        agentType: "explorer",
      }),
    ],
    findings: [
      {
        id: "f5",
        title: "Cart total ignores item quantities",
        body: "I added Blue Notebook ×2 (¥500) and Sticky Notes ×3 (¥280). The cart total showed ¥780 — the sum of unit prices — instead of ¥1,840. Quantity is displayed but not multiplied into the total.",
        category: "bug",
        agentId: "b1",
        agentName: "Jordan Blake",
        role: "first-time shopper",
        timestamp: "2026-08-30T14:10:00.000Z",
      },
      {
        id: "f6",
        title: "Delete removes an item instantly with no confirmation or undo",
        body: "On /items, clicking Delete submits immediately. There is no confirm dialog and no undo toast. I accidentally wiped Fountain Pen while trying to clear a different row.",
        category: "ux",
        agentId: "b2",
        agentName: "Riley Park",
        role: "inventory clerk",
        timestamp: "2026-08-30T14:12:30.000Z",
      },
      {
        id: "f7",
        title: "Long product names silently fail to save",
        body: "I entered a 24-character item name and submitted Add. The form redirected back to /items with no error, but the new row never appeared. Anything over 20 characters seems to be discarded while looking successful.",
        category: "bug",
        agentId: "b2",
        agentName: "Riley Park",
        role: "inventory clerk",
        timestamp: "2026-08-30T14:16:00.000Z",
      },
      {
        id: "f8",
        title: "No way to compare items before buying",
        body: "As a power buyer I wanted a side-by-side or at least a saved shortlist. The store only offers a flat table and a cart — there is no wishlist or compare flow for deciding between notebooks and pens.",
        category: "feature-request",
        agentId: "b4",
        agentName: "Alex Rivera",
        role: "power buyer",
        timestamp: "2026-08-30T14:19:00.000Z",
      },
      {
        id: "f9",
        title: "Store never states what a successful purchase looks like",
        body: "The app describes itself as a store, but after adding items to the cart there is no checkout, confirmation, or order history. The stated goal of letting shoppers complete a purchase has no path to completion.",
        category: "goal-gap",
        agentId: "b1",
        agentName: "Jordan Blake",
        role: "first-time shopper",
        timestamp: "2026-08-30T14:20:30.000Z",
      },
    ],
  },
];

// logs + findings
fs.mkdirSync(path.join(root, "logs"), { recursive: true });
for (const r of runs) {
  const stamp = r.startedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const logName = `${stamp}_${r.runId}.json`;
  fs.writeFileSync(
    path.join(root, "logs", logName),
    JSON.stringify(runLog(r), null, 2),
  );
  const fdir = path.join(root, "findings", r.runId);
  fs.mkdirSync(fdir, { recursive: true });
  for (const f of r.findings) {
    fs.writeFileSync(
      path.join(fdir, `${f.id}.json`),
      JSON.stringify(finding({ ...f, runId: r.runId }), null, 2),
    );
  }
  // Simple text log for run detail
  const lines = [
    `[${r.startedAt}] starting run ${r.runId} against ${BASE}`,
    ...r.agents.map((a) => `[${a.startedAt}] agent ${a.agentName} (${a.role}) started`),
    ...r.findings.map((f) => `[${f.timestamp}] finding: [${f.category}] ${f.title}`),
    `[${r.completedAt}] run completed — ${r.findings.length} findings`,
  ];
  fs.writeFileSync(path.join(root, "logs", `${r.runId}.log`), lines.join("\n") + "\n");
}

// coverage for experience score
fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
fs.writeFileSync(
  path.join(root, "coverage", "coverage.json"),
  JSON.stringify(
    {
      entries: [
        {
          runId: runs[0].runId,
          timestamp: runs[0].completedAt,
          findingsCount: 4,
          byCategory: { bug: 2, ux: 2 },
          byLens: { accessibility: 2, security: 1, functional: 1 },
          byScenario: { "Browse featured item": 1, "Check admin area": 1 },
          visitedPaths: ["/", "/items", "/cart", "/admin", "/help"],
          scenarioOutcomes: [
            { scenarioTitle: "Browse featured item", achieved: true, iterations: 5 },
            { scenarioTitle: "Open help docs", achieved: false, iterations: 3 },
            { scenarioTitle: "Check admin area", achieved: true, iterations: 4 },
          ],
          regression: { checked: 2, regressed: 1 },
        },
        {
          runId: runs[1].runId,
          timestamp: runs[1].completedAt,
          findingsCount: 5,
          byCategory: { bug: 2, ux: 1, "feature-request": 1, "goal-gap": 1 },
          byLens: { functional: 2, usability: 1, accessibility: 1 },
          byScenario: { "Fill a cart": 1, "Add inventory": 1 },
          visitedPaths: ["/", "/items", "/cart", "/admin"],
          scenarioOutcomes: [
            { scenarioTitle: "Fill a cart with quantities", achieved: true, iterations: 6 },
            { scenarioTitle: "Add a new inventory item", achieved: false, iterations: 7 },
            { scenarioTitle: "Complete checkout", achieved: false, iterations: 4 },
            { scenarioTitle: "Recover from accidental delete", achieved: false, iterations: 3 },
          ],
          regression: { checked: 3, regressed: 0 },
        },
      ],
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(root, "coverage", "site-map.json"),
  JSON.stringify(
    {
      origin: BASE,
      updatedAt: runs[1].completedAt,
      entries: {
        "/": { path: "/", source: "sitemap", status: "explored", visitCount: 8, maxConsecutiveIterations: 3, lastVisitedAt: runs[1].completedAt, lastRunId: runs[1].runId },
        "/items": { path: "/items", source: "sitemap", status: "explored", visitCount: 6, maxConsecutiveIterations: 4, lastVisitedAt: runs[1].completedAt, lastRunId: runs[1].runId },
        "/cart": { path: "/cart", source: "sitemap", status: "explored", visitCount: 4, maxConsecutiveIterations: 2, lastVisitedAt: runs[1].completedAt, lastRunId: runs[1].runId },
        "/admin": { path: "/admin", source: "discovered", status: "reached", visitCount: 2, maxConsecutiveIterations: 1, lastVisitedAt: runs[0].completedAt, lastRunId: runs[0].runId },
        "/help": { path: "/help", source: "sitemap", status: "reached", visitCount: 1, maxConsecutiveIterations: 1, lastVisitedAt: runs[0].completedAt, lastRunId: runs[0].runId },
        "/checkout": { path: "/checkout", source: "discovered", status: "unvisited", visitCount: 0, maxConsecutiveIterations: 0, lastVisitedAt: null, lastRunId: null },
      },
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(root, "coverage", "adoption.json"),
  JSON.stringify(
    {
      byLens: {
        accessibility: { adopted: 2, rejected: 0 },
        security: { adopted: 1, rejected: 0 },
        functional: { adopted: 1, rejected: 1 },
        usability: { adopted: 1, rejected: 0 },
      },
      byCategory: {
        bug: { adopted: 2, rejected: 1 },
        ux: { adopted: 3, rejected: 0 },
      },
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(root, "coverage", "issue-links.json"),
  JSON.stringify(
    [
      {
        url: "https://github.com/example/bench-store/issues/12",
        title: "[bug] Help nav link returns 404",
        category: "bug",
        lenses: ["functional"],
        scenarios: ["Open help docs"],
        runId: runs[0].runId,
        createdAt: runs[0].completedAt,
        resolution: "adopted",
        resolvedAt: "2026-08-29T09:00:00.000Z",
      },
      {
        url: "https://github.com/example/bench-store/issues/13",
        title: "[ux] Buy button text is nearly invisible",
        category: "ux",
        lenses: ["accessibility"],
        scenarios: ["Browse featured item"],
        runId: runs[0].runId,
        createdAt: runs[0].completedAt,
        resolution: "adopted",
        resolvedAt: "2026-08-29T11:00:00.000Z",
      },
      {
        url: "https://github.com/example/bench-store/issues/14",
        title: "[bug] Cart total ignores item quantities",
        category: "bug",
        lenses: ["functional"],
        scenarios: ["Fill a cart with quantities"],
        runId: runs[1].runId,
        createdAt: runs[1].completedAt,
        resolution: "rejected",
        resolvedAt: "2026-08-31T08:00:00.000Z",
      },
    ],
    null,
    2,
  ),
);

fs.mkdirSync(path.join(root, "product-specs"), { recursive: true });
fs.writeFileSync(
  path.join(root, "product-specs", `${hostKey}.json`),
  JSON.stringify(
    {
      appName: "bench store",
      appDescription: "A tiny storefront for browsing items and managing a cart.",
      targetUsers: "Shoppers and inventory clerks testing the store flows",
      features: "Browse items, add to cart, admin inventory, help link",
      designContext: "Minimal HTML store used as shoal's detection benchmark target",
      uiFeatures: "Nav, item table, cart totals, admin panel",
      appGoals: [
        "Let a shopper browse items and complete a purchase",
        "Let staff manage inventory without accidental data loss",
        "Keep administrative actions behind authentication",
      ],
      confidence: "high",
      sources: ["UI observation", "README"],
      discoveredAt: runs[0].startedAt,
      productEdge: {
        sharpEdges: [
          "Every flow stays keyboard-reachable with plain HTML forms — no mouse-only widgets",
        ],
        tradeoffs: [
          "No onboarding wizard — the store assumes a trained operator",
        ],
        source: "human",
      },
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(root, "agents.json"),
  JSON.stringify(
    [
      {
        id: "persona_maya",
        name: "Maya Chen",
        role: "accessibility auditor",
        persona: "Notices contrast, alt text, and keyboard traps immediately.",
        createdAt: runs[0].startedAt,
        origin: "fixed",
        status: "active",
        lenses: ["accessibility"],
      },
      {
        id: "persona_jordan",
        name: "Jordan Blake",
        role: "first-time shopper",
        persona: "New to the store; expects clear help and a working checkout.",
        createdAt: runs[0].startedAt,
        origin: "fixed",
        status: "active",
        lenses: ["usability"],
      },
      {
        id: "persona_sam",
        name: "Sam Okada",
        role: "security-minded admin",
        persona: "Probes auth boundaries and privilege edges.",
        createdAt: runs[0].startedAt,
        origin: "auto",
        status: "active",
        lenses: ["security"],
      },
    ],
    null,
    2,
  ),
);

console.log("Seeded dashboard demo data for", BASE);
console.log("Runs:", runs.map((r) => r.runId).join(", "));
