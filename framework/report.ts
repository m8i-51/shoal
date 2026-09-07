import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Finding, RunLog, RegressionCheck } from "./types";
import type { ProductSpec } from "./product-discovery";
import type { TriageResult } from "./triage";
import type { Scenario, ScenarioOutcome } from "./scenario-designer";
import type { ExperienceScore } from "./experience-score";
import { formatIssueRef } from "./issue-id";
import { getKnownSecrets, replaceAllLiteral } from "./trace-scrub";
import * as log from "./log";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function embedImage(filePath: string | undefined): string | null {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

// Matches an embedded screenshot's data: URI as produced by embedImage() above
// — always image/png, always base64. Used to shield the image payload from
// scrubReportHtml() below.
const IMAGE_DATA_URI_RE = /data:image\/png;base64,[A-Za-z0-9+/=]+/g;

/**
 * Redacts every known secret (test-account passwords, values typed into a
 * field shoal detected as a password — see trace-scrub.ts's SecretRegistry)
 * out of the fully-rendered report HTML, right before it is written to disk.
 * Findings are written by an LLM describing what it saw and did, so a
 * secret it typed into the target app can end up quoted in a finding's
 * title or body; agent names and assignment tags are likewise free text.
 * Scrubbing the whole document this late — rather than each field at the
 * point it's interpolated — means nothing this file renders can slip past
 * it, including anything a future change adds without remembering to scrub
 * its own input.
 *
 * Uses the exact same literal string-replace (`replaceAllLiteral`) that
 * `scrubTraceZip` already applies to trace zips, so the report gets the same
 * redaction behaviour as the trace rather than a second implementation that
 * could drift from it.
 *
 * The one thing a whole-document replace must not touch is the base64
 * payload of an embedded screenshot: a short registered secret (>=4 chars)
 * can coincidentally occur as a substring of arbitrary base64 text, and
 * replacing it there would corrupt the image without redacting anything a
 * person could actually read off the picture (screenshot pixels can't be
 * scrubbed at all — see the warning banner and SECURITY.md). So every
 * `data:image/png;base64,...` URI is pulled out from behind a random,
 * per-call marker before the scrub runs over the rest of the document, and
 * spliced back in completely untouched afterwards. The marker is generated
 * fresh from `crypto.randomBytes` on every call, so it cannot collide with
 * real report content or with a registered secret, which is what makes the
 * swap-out/swap-back safe.
 */
function scrubReportHtml(html: string): string {
  const secrets = getKnownSecrets();
  if (secrets.length === 0) return html;

  try {
    const marker = crypto.randomBytes(16).toString("hex");
    const placeholderRe = new RegExp(`@@REPORT_IMG_${marker}_(\\d+)@@`, "g");

    const dataUris: string[] = [];
    const withPlaceholders = html.replace(IMAGE_DATA_URI_RE, (match) => {
      dataUris.push(match);
      return `@@REPORT_IMG_${marker}_${dataUris.length - 1}@@`;
    });

    let scrubbed = withPlaceholders;
    for (const secret of secrets) {
      scrubbed = replaceAllLiteral(scrubbed, secret).text;
    }

    return scrubbed.replace(placeholderRe, (_match, i: string) => dataUris[Number(i)]);
  } catch (e) {
    // Never let a scrub bug break report generation — an unscrubbed report
    // that still exists beats no report at all, same rationale as
    // scrubTraceZipSafely in trace-scrub.ts.
    log.warn("[report] failed to scrub known secrets from report HTML:", e);
    return html;
  }
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Same hex values as web/src/utils/format.ts's CATEGORY_COLOR (bug/ux/feature-request)
// — this file is a standalone server-side HTML generator and can't import
// from web/src, so keep these in sync by hand. Darker than the naive
// "500" shade of each hue: white text on top (see `.badge`, `.bar-segment
// span`) needs >=4.5:1 contrast against the background, which the lighter
// shade fails (2.8-3.8:1). See framework/__tests__/report.test.ts for the
// pinned contrast ratios.
function categoryColor(cat: string): string {
  switch (cat) {
    case "bug": return "#dc2626";
    case "ux": return "#c2410c";
    case "feature-request": return "#2563eb";
    default: return "#6b7280";
  }
}

export function generateReport(
  runLog: RunLog,
  findings: Finding[],
  triageResult: TriageResult,
  productSpec: ProductSpec,
  scenarios: Scenario[],
  agentAssignments: Map<string, { scenario?: Scenario; lens?: string }>,
  scenarioOutcomes: ScenarioOutcome[] = [],
  experience: ExperienceScore | null = null,
): string {
  const reportPath = path.join(process.cwd(), "logs", `report_${runLog.runId}.html`);

  const allRegressionChecks: RegressionCheck[] = runLog.agents.flatMap((a) => a.regressionChecks ?? []);
  const fixedChecks = allRegressionChecks.filter((c) => c.status === "fixed");
  const regressedChecks = allRegressionChecks.filter((c) => c.status === "regressed");

  const issuedSet = new Set(triageResult.issued);
  const skippedSet = new Set(triageResult.skipped);

  // issued → unprocessed → skipped の順に並べる
  const sortedFindings = [...findings].sort((a, b) => {
    const rank = (f: Finding) => (issuedSet.has(f.id) ? 0 : !skippedSet.has(f.id) ? 1 : 2);
    return rank(a) - rank(b);
  });

  const categoryCounts: Record<string, number> = {};
  for (const f of findings) {
    categoryCounts[f.category] = (categoryCounts[f.category] ?? 0) + 1;
  }

  const duration = formatDuration(runLog.startedAt, runLog.completedAt);
  const date = new Date(runLog.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  // ----------------------------------------------------------------
  // Finding cards
  // ----------------------------------------------------------------

  const findingCards = sortedFindings.map((f) => {
    const status = issuedSet.has(f.id) ? "issued" : skippedSet.has(f.id) ? "skipped" : "unprocessed";
    const statusLabel = { issued: "→ Issue", skipped: "skipped", unprocessed: "pending" }[status];
    // Darkened for >=4.5:1 contrast against the white .badge text (see categoryColor above).
    const statusColor = { issued: "#15803d", skipped: "#6b7280", unprocessed: "#b45309" }[status];
    const imgData = embedImage(f.screenshotPath);
    const assignment = agentAssignments.get(f.agentId);
    const assignmentTag = assignment?.scenario
      ? `<span class="assignment-tag scenario">scenario: ${esc(assignment.scenario.title)}</span>`
      : assignment?.lens
      ? `<span class="assignment-tag lens">lens: ${esc(assignment.lens.split(":")[0].trim())}</span>`
      : "";

    return `
<div class="finding ${esc(status)}">
  <div class="finding-header">
    <span class="badge" style="background:${categoryColor(f.category)}">${esc(f.category)}</span>
    <span class="badge" style="background:${statusColor}">${statusLabel}</span>
    ${assignmentTag}
    <span class="agent-name">${esc(f.agentName)}</span>
  </div>
  <h3 class="finding-title">${esc(f.title)}</h3>
  <p class="finding-body">${esc(f.body).replace(/\n/g, "<br>")}</p>
  ${imgData ? `<details class="screenshot-toggle"><summary>スクリーンショット</summary><img src="${imgData}" alt="screenshot" class="screenshot"></details>` : ""}
  ${f.tracePath && fs.existsSync(f.tracePath) ? `<div class="trace-hint">▶ replay this session: <code>npx playwright show-trace ${esc(f.tracePath)}</code></div>` : ""}
</div>`;
  }).join("\n");

  // ----------------------------------------------------------------
  // Agent table rows
  // ----------------------------------------------------------------

  const agentRows = runLog.agents.map((a) => {
    const assignment = agentAssignments.get(a.agentId);
    // Darkened for >=4.5:1 contrast against the white .badge text (see categoryColor above).
    const assignmentCell = assignment?.scenario
      ? `<span class="badge" style="background:#7c3aed">scenario</span>&nbsp;${esc(assignment.scenario.title)}`
      : assignment?.lens
      ? `<span class="badge" style="background:#0369a1">lens</span>&nbsp;${esc(assignment.lens.split(":")[0].trim())}`
      : `<span class="badge" style="background:#6b7280">${esc(a.agentType)}</span>`;
    const statusColor = a.status === "completed" ? "#15803d" : "#dc2626";
    return `<tr>
  <td>${esc(a.agentName)}</td>
  <td><span class="badge" style="background:#475569">${esc(a.agentType)}</span></td>
  <td style="font-size:0.8rem">${assignmentCell}</td>
  <td style="text-align:center">${a.iterations}</td>
  <td><span class="badge" style="background:${statusColor}">${esc(a.status)}</span></td>
</tr>`;
  }).join("\n");

  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Scenario outcomes
  // ----------------------------------------------------------------

  const outcomesSection = scenarioOutcomes.length > 0 ? (() => {
    const achieved = scenarioOutcomes.filter((o) => o.achieved).length;
    const total = scenarioOutcomes.length;
    const allPassed = achieved === total;
    // Darkened for >=4.5:1 contrast against this h2's #f8fafc (body) background
    // — same palette as categoryColor/statusColor above and scoreColor below.
    const headerColor = allPassed ? "#15803d" : achieved === 0 ? "#dc2626" : "#b45309";
    const rows = scenarioOutcomes.map((o) => `<tr>
  <td>${esc(o.scenarioTitle)}</td>
  <td>${esc(o.agentName)}</td>
  <td><span class="badge" style="background:${o.achieved ? "#15803d" : "#dc2626"}">${o.achieved ? "achieved" : "failed"}</span></td>
  <td style="font-size:.8rem;color:#475569">${esc(o.reason)}</td>
</tr>`).join("\n");
    return `
<section>
  <h2>Scenario Outcomes <span style="font-size:.85rem;color:${headerColor};text-transform:none;letter-spacing:0;font-weight:600">${achieved}/${total} achieved</span></h2>
  <table>
    <thead><tr><th>Scenario</th><th>Agent</th><th>Result</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
  })() : "";

  // ----------------------------------------------------------------
  // Scenario cards
  // ----------------------------------------------------------------

  const scenarioSection = scenarios.length > 0 ? `
<section>
  <h2>Scenarios (${scenarios.length})</h2>
  <div class="scenarios">
    ${scenarios.map((s) => `
    <div class="scenario-card">
      <div class="scenario-id">${esc(s.id)}</div>
      <h3>${esc(s.title)}</h3>
      <p><strong>Context:</strong> ${esc(s.context)}</p>
      <p><strong>Goal:</strong> ${esc(s.goal)}</p>
      <p><strong>Constraints:</strong> ${esc(s.constraints)}</p>
    </div>`).join("")}
  </div>
</section>` : "";

  // ----------------------------------------------------------------
  // Category bar
  // ----------------------------------------------------------------

  const totalFindings = findings.length;
  const categoryBar = ["bug", "ux", "feature-request"]
    .filter((cat) => categoryCounts[cat])
    .map((cat) => {
      const count = categoryCounts[cat] ?? 0;
      const pct = totalFindings > 0 ? Math.max(Math.round((count / totalFindings) * 100), 8) : 0;
      return `<div class="bar-segment" style="width:${pct}%;background:${categoryColor(cat)}" title="${cat}: ${count}">
  <span>${esc(cat)} ${count}</span>
</div>`;
    }).join("");

  // ----------------------------------------------------------------
  // Full HTML
  // ----------------------------------------------------------------

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>shoal — ${esc(productSpec.appName)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#1e293b;line-height:1.5}
    header{background:#1e293b;color:#f8fafc;padding:1.5rem 2rem}
    header h1{font-size:1.25rem;font-weight:700;margin-bottom:.25rem}
    header .meta{font-size:.875rem;color:#94a3b8}
    main{max-width:960px;margin:0 auto;padding:2rem}
    section{margin-bottom:2.5rem}
    h2{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid #e2e8f0}
    .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:1rem;margin-bottom:1.25rem}
    .stat-card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:1rem;text-align:center}
    .stat-card .number{font-size:2rem;font-weight:700;color:#1e293b}
    .stat-card .label{font-size:.7rem;color:#64748b;margin-top:.25rem;text-transform:uppercase;letter-spacing:.05em}
    .category-bar{display:flex;height:28px;border-radius:6px;overflow:hidden;background:#e2e8f0;margin-bottom:0}
    .bar-segment{display:flex;align-items:center;padding:0 .5rem;min-width:60px}
    .bar-segment span{font-size:.7rem;color:#fff;font-weight:700;white-space:nowrap}
    .badge{display:inline-block;padding:.15rem .5rem;border-radius:9999px;font-size:.65rem;font-weight:700;color:#fff;white-space:nowrap}
    .finding{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:1rem 1.25rem;margin-bottom:.75rem}
    /* Deliberately de-emphasised, not held to AA: opacity:.55 multiplies every
       foreground/background pair inside a skipped card, so reaching 4.5:1 here
       would need near-black text that defeats the fade. Skipped findings are
       de-prioritized by design — this is the one exception to the contrast
       pass below. */
    .finding.skipped{opacity:.55}
    .finding-header{display:flex;align-items:center;gap:.4rem;margin-bottom:.5rem;flex-wrap:wrap}
    .agent-name{font-size:.75rem;color:#64748b;margin-left:auto}
    .assignment-tag{font-size:.7rem;padding:.1rem .45rem;border-radius:4px;white-space:nowrap}
    .assignment-tag.scenario{color:#7c3aed;background:#ede9fe}
    .assignment-tag.lens{color:#0369a1;background:#e0f2fe}
    .finding-title{font-size:.95rem;font-weight:600;margin-bottom:.35rem}
    .finding-body{font-size:.85rem;color:#475569}
    .trace-hint{margin-top:.6rem;font-size:.75rem;color:#64748b}
    .trace-hint code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:.1rem .4rem;font-size:.72rem;user-select:all}
    .screenshot-toggle{margin-top:.75rem}
    .screenshot-toggle summary{font-size:.8rem;color:#64748b;cursor:pointer;user-select:none}
    .screenshot{max-width:100%;max-height:400px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px;margin-top:.5rem;display:block}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:.85rem}
    th{background:#f1f5f9;padding:.6rem 1rem;text-align:left;font-weight:700;color:#475569;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
    td{padding:.6rem 1rem;border-top:1px solid #e2e8f0;vertical-align:middle}
    .scenarios{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
    .scenario-card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:1rem}
    .scenario-id{font-size:.65rem;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.25rem}
    .scenario-card h3{font-size:.875rem;font-weight:600;margin-bottom:.5rem}
    .scenario-card p{font-size:.8rem;color:#475569;margin-top:.2rem}
    /* #78350f on #fef3c7 = 8.15:1 (WCAG AA requires >=4.5:1 for normal text)
       — computed via the same relative-luminance formula report.test.ts uses
       to verify every other colour in this file. */
    .security-banner{background:#fef3c7;border:1px solid #f59e0b;color:#78350f;padding:.85rem 1.5rem;font-size:.85rem;font-weight:600;line-height:1.4}
    .security-banner .icon{margin-right:.35rem}
  </style>
</head>
<body>
<div class="security-banner"><span class="icon">⚠</span>This report embeds full-page screenshots captured during an authenticated session. Finding text has been scanned for known secrets and redacted, but screenshot <strong>images are not</strong> — treat this file as sensitive and review it before sharing or attaching it anywhere outside your team.</div>
<header>
  <h1>shoal &mdash; ${esc(productSpec.appName)}</h1>
  <p class="meta">${esc(date)}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${esc(duration)}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${esc(runLog.runId)}</p>
</header>
<main>
  <section>
    <h2>Summary</h2>
    <div class="summary-grid">
      ${experience ? (() => {
        // Darkened for >=4.5:1 against this .stat-card's white background (see categoryColor above).
        const scoreColor = experience.latest.score >= 70 ? "#15803d" : experience.latest.score >= 40 ? "#b45309" : "#dc2626";
        const deltaBadge = experience.delta == null ? ""
          : experience.delta > 0 ? `<span style="font-size:.8rem;color:#15803d;font-weight:700"> ▲${experience.delta}</span>`
          : experience.delta < 0 ? `<span style="font-size:.8rem;color:#dc2626;font-weight:700"> ▼${Math.abs(experience.delta)}</span>`
          : `<span style="font-size:.8rem;color:#64748b;font-weight:700"> ±0</span>`;
        return `<div class="stat-card"><div class="number" style="color:${scoreColor}">${experience.latest.score}${deltaBadge}</div><div class="label">experience score</div></div>`;
      })() : ""}
      <div class="stat-card"><div class="number">${findings.length}</div><div class="label">findings</div></div>
      <div class="stat-card"><div class="number">${triageResult.issued.length}</div><div class="label">→ Issues</div></div>
      ${(() => {
        // Critical only: a card per level would push the grid past a screen,
        // and "how many must be looked at today" is the one that changes plans.
        const critical = triageResult.issues.filter((i) => i.severity === "critical").length;
        // #b91c1c is 6.47:1 on this .stat-card's white background.
        return critical > 0
          ? `<div class="stat-card"><div class="number" style="color:#b91c1c">${critical}</div><div class="label">critical</div></div>`
          : "";
      })()}
      <div class="stat-card"><div class="number">${triageResult.skipped.length}</div><div class="label">skipped</div></div>
      <div class="stat-card"><div class="number">${triageResult.unprocessed.length}</div><div class="label">pending</div></div>
      <div class="stat-card"><div class="number">${runLog.agents.length}</div><div class="label">agents</div></div>
      ${allRegressionChecks.length > 0 ? `<div class="stat-card"><div class="number" style="color:#15803d">${fixedChecks.length}</div><div class="label">still fixed</div></div><div class="stat-card"><div class="number" style="color:${regressedChecks.length > 0 ? "#dc2626" : "#64748b"}">${regressedChecks.length}</div><div class="label">regressed</div></div>` : ""}
    </div>
    <div class="category-bar">${categoryBar || '<div style="width:100%;display:flex;align-items:center;padding:0 .75rem;font-size:.75rem;color:#475569">no findings</div>'}</div>
  </section>

  ${allRegressionChecks.length > 0 ? `
  <section>
    <h2>Progress (${allRegressionChecks.length} issues checked)</h2>
    ${regressedChecks.length > 0 ? `<p style="color:#dc2626;font-size:.875rem;margin-bottom:.75rem">⚠ ${regressedChecks.length} regression${regressedChecks.length !== 1 ? "s" : ""} detected</p>` : `<p style="color:#15803d;font-size:.875rem;margin-bottom:.75rem">✓ All previously fixed issues remain resolved</p>`}
    <table>
      <thead><tr><th>ID</th><th>Issue</th><th style="text-align:center">Status</th></tr></thead>
      <tbody>
        ${allRegressionChecks.map((c) => `
        <tr>
          <td style="color:#64748b">${formatIssueRef(c.issueNumber)}</td>
          <td>${esc(c.issueTitle)}</td>
          <td style="text-align:center">${c.status === "fixed" ? '<span class="badge" style="background:#15803d">✓ fixed</span>' : '<span class="badge" style="background:#dc2626">⚠ regressed</span>'}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <section>
    <h2>Findings (${findings.length})</h2>
    ${sortedFindings.length > 0 ? findingCards : "<p style='color:#64748b;font-size:.875rem'>No findings collected.</p>"}
  </section>

  ${outcomesSection}

  ${scenarioSection}

  <section>
    <h2>Agents (${runLog.agents.length})</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Type</th><th>Assignment</th><th style="text-align:center">Iter.</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${agentRows}
      </tbody>
    </table>
  </section>
</main>
</body>
</html>`;

  const scrubbedHtml = scrubReportHtml(html);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, scrubbedHtml, "utf-8");
  return reportPath;
}
