import * as fs from "fs";
import * as path from "path";
import type { Finding, RunLog, RegressionCheck } from "./types";
import type { ProductSpec } from "./product-discovery";
import type { TriageResult } from "./triage";
import type { Scenario, ScenarioOutcome } from "./scenario-designer";

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

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function categoryColor(cat: string): string {
  switch (cat) {
    case "bug": return "#ef4444";
    case "ux": return "#f97316";
    case "feature-request": return "#3b82f6";
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
    const statusColor = { issued: "#22c55e", skipped: "#9ca3af", unprocessed: "#f59e0b" }[status];
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
</div>`;
  }).join("\n");

  // ----------------------------------------------------------------
  // Agent table rows
  // ----------------------------------------------------------------

  const agentRows = runLog.agents.map((a) => {
    const assignment = agentAssignments.get(a.agentId);
    const assignmentCell = assignment?.scenario
      ? `<span class="badge" style="background:#8b5cf6">scenario</span>&nbsp;${esc(assignment.scenario.title)}`
      : assignment?.lens
      ? `<span class="badge" style="background:#0ea5e9">lens</span>&nbsp;${esc(assignment.lens.split(":")[0].trim())}`
      : `<span class="badge" style="background:#9ca3af">${a.agentType === "regression" ? "regression" : "—"}</span>`;
    const statusColor = a.status === "completed" ? "#22c55e" : "#ef4444";
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
    const headerColor = allPassed ? "#22c55e" : achieved === 0 ? "#ef4444" : "#f59e0b";
    const rows = scenarioOutcomes.map((o) => `<tr>
  <td>${esc(o.scenarioTitle)}</td>
  <td>${esc(o.agentName)}</td>
  <td><span class="badge" style="background:${o.achieved ? "#22c55e" : "#ef4444"}">${o.achieved ? "achieved" : "failed"}</span></td>
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
    .finding.skipped{opacity:.55}
    .finding-header{display:flex;align-items:center;gap:.4rem;margin-bottom:.5rem;flex-wrap:wrap}
    .agent-name{font-size:.75rem;color:#94a3b8;margin-left:auto}
    .assignment-tag{font-size:.7rem;padding:.1rem .45rem;border-radius:4px;white-space:nowrap}
    .assignment-tag.scenario{color:#7c3aed;background:#ede9fe}
    .assignment-tag.lens{color:#0369a1;background:#e0f2fe}
    .finding-title{font-size:.95rem;font-weight:600;margin-bottom:.35rem}
    .finding-body{font-size:.85rem;color:#475569}
    .screenshot-toggle{margin-top:.75rem}
    .screenshot-toggle summary{font-size:.8rem;color:#64748b;cursor:pointer;user-select:none}
    .screenshot{max-width:100%;max-height:400px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px;margin-top:.5rem;display:block}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:.85rem}
    th{background:#f1f5f9;padding:.6rem 1rem;text-align:left;font-weight:700;color:#64748b;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
    td{padding:.6rem 1rem;border-top:1px solid #e2e8f0;vertical-align:middle}
    .scenarios{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
    .scenario-card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:1rem}
    .scenario-id{font-size:.65rem;font-weight:700;color:#8b5cf6;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.25rem}
    .scenario-card h3{font-size:.875rem;font-weight:600;margin-bottom:.5rem}
    .scenario-card p{font-size:.8rem;color:#475569;margin-top:.2rem}
  </style>
</head>
<body>
<header>
  <h1>shoal &mdash; ${esc(productSpec.appName)}</h1>
  <p class="meta">${esc(date)}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${esc(duration)}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${esc(runLog.runId)}</p>
</header>
<main>
  <section>
    <h2>Summary</h2>
    <div class="summary-grid">
      <div class="stat-card"><div class="number">${findings.length}</div><div class="label">findings</div></div>
      <div class="stat-card"><div class="number">${triageResult.issued.length}</div><div class="label">→ Issues</div></div>
      <div class="stat-card"><div class="number">${triageResult.skipped.length}</div><div class="label">skipped</div></div>
      <div class="stat-card"><div class="number">${triageResult.unprocessed.length}</div><div class="label">pending</div></div>
      <div class="stat-card"><div class="number">${runLog.agents.length}</div><div class="label">agents</div></div>
      ${allRegressionChecks.length > 0 ? `<div class="stat-card"><div class="number" style="color:#22c55e">${fixedChecks.length}</div><div class="label">still fixed</div></div><div class="stat-card"><div class="number" style="color:${regressedChecks.length > 0 ? "#ef4444" : "#94a3b8"}">${regressedChecks.length}</div><div class="label">regressed</div></div>` : ""}
    </div>
    <div class="category-bar">${categoryBar || '<div style="width:100%;display:flex;align-items:center;padding:0 .75rem;font-size:.75rem;color:#94a3b8">no findings</div>'}</div>
  </section>

  ${allRegressionChecks.length > 0 ? `
  <section>
    <h2>Progress (${allRegressionChecks.length} issues checked)</h2>
    ${regressedChecks.length > 0 ? `<p style="color:#ef4444;font-size:.875rem;margin-bottom:.75rem">⚠ ${regressedChecks.length} regression${regressedChecks.length !== 1 ? "s" : ""} detected</p>` : `<p style="color:#22c55e;font-size:.875rem;margin-bottom:.75rem">✓ All previously fixed issues remain resolved</p>`}
    <table>
      <thead><tr><th>#</th><th>Issue</th><th style="text-align:center">Status</th></tr></thead>
      <tbody>
        ${allRegressionChecks.map((c) => `
        <tr>
          <td style="color:#94a3b8">#${c.issueNumber}</td>
          <td>${esc(c.issueTitle)}</td>
          <td style="text-align:center">${c.status === "fixed" ? '<span class="badge" style="background:#22c55e">✓ fixed</span>' : '<span class="badge" style="background:#ef4444">⚠ regressed</span>'}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <section>
    <h2>Findings (${findings.length})</h2>
    ${sortedFindings.length > 0 ? findingCards : "<p style='color:#94a3b8;font-size:.875rem'>No findings collected.</p>"}
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

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, html, "utf-8");
  return reportPath;
}
