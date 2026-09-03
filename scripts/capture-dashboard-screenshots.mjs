/**
 * Capture README screenshots from a live `shoal serve` with seeded dashboard data.
 *
 * Prerequisites:
 *   1. Bench target: node --import tsx -e 'import { createBenchApp } from "./bench/app.ts"; createBenchApp().listen(3456)'
 *   2. Seed:        node scripts/seed-dashboard-demo.mjs
 *   3. Serve:        BASE_URL=http://localhost:3456 npm run serve
 *
 * Then: node scripts/capture-dashboard-screenshots.mjs
 */
import { chromium } from "playwright";
import * as path from "path";
import * as fs from "fs";

const outDir = path.join(process.cwd(), "assets");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function shot(name, url, waitTexts, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
  });
  await context.addInitScript(() => localStorage.setItem("shoal-lang", "en"));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  for (const text of waitTexts) {
    await page.waitForSelector(`text=${text}`, { timeout: 15000 });
  }
  await page.waitForTimeout(700);
  const dest = path.join(outDir, name);
  await page.screenshot({ path: dest, type: "png" });
  console.log("wrote", dest, fs.statSync(dest).size, "bytes");
  await context.close();
}

await shot(
  "dashboard.png",
  "http://127.0.0.1:4000/",
  ["Experience Score", "Site Map Coverage"],
  { width: 1280, height: 1100 },
);

await shot(
  "dashboard-hall.png",
  "http://127.0.0.1:4000/hall",
  ["Hall of Issues", "9 findings"],
  { width: 1280, height: 960 },
);

await browser.close();
