[日本語版はこちら](README_JA.md)


<p align="center">
  <img src="assets/logo-lockup.svg" alt="shoal" height="72">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@m8i-51/shoal"><img src="https://img.shields.io/npm/v/@m8i-51/shoal?color=red" alt="npm"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://playwright.dev/"><img src="https://img.shields.io/badge/Playwright-browser-45ba4b?logo=playwright&logoColor=white" alt="Playwright"></a>
  <a href="https://www.anthropic.com/"><img src="https://img.shields.io/badge/Anthropic-Claude-blueviolet?logo=anthropic&logoColor=white" alt="Anthropic"></a>
</p>

**AI agents that experience your app — and help it grow.**

shoal drops a swarm of AI agents onto a web app. Each agent has a distinct persona and explores the app as a real user would — navigating pages, taking actions, noticing friction. They surface bugs, usability issues, missing features, and gaps between what the app does and what it's meant to achieve.

No test scripts. No test data. No prior knowledge of the app required. Just a URL.

---

## How it works

```
Target App (any URL)
        │
        ▼  autonomously learns what the app does + its goals
  Product Discovery
        │
        ▼  generates a user persona team for that app
  Org Design
        │
        ▼  creates and maintains the agent roster
  HR Agent
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
  API Agents  ×N                   Browser Agents  ×N
  explore via API                  browse the real UI
        │                                  │
        └──────────────┬───────────────────┘
                       ▼  deduplicates and files issue tickets
                 Triage Agent
```

Each agent carries a distinct perspective — accessibility, security, business logic, UI design, new user experience, and more. They operate on a shared understanding of the app's purpose and goals. Coverage is tracked across runs, so each session naturally focuses on areas that haven't been explored yet.

---

## What it finds

At the end of each run:

- **Bugs** — broken flows, errors, inconsistent data
- **UX issues** — confusing interactions, dead ends, unclear states
- **Feature suggestions** — things that would add real value
- **Goal gaps** — where the app falls short of what it's trying to achieve

Findings are filed as issue tickets (GitHub Issues, Jira, Notion, Backlog, or Asana) or saved as a self-contained HTML report. A **web dashboard** lets you start runs, watch live progress, review findings by category, and track estimated LLM cost per run.

---

## Quick Start

**Install globally:**

```bash
npm install -g @m8i-51/shoal
npx playwright install chromium
```

Move to the directory that should hold shoal's config, then run:

```bash
cd your-project          # or a subdirectory — see [Where config lives](#where-config-lives)
shoal init               # creates .env with all available options
```

Open `.env` and set at minimum:

```env
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:3000   # URL of the app to explore
```

Then run **from that same directory**:

```bash
shoal serve    # open web dashboard at http://localhost:4000
shoal          # or run agents directly from the terminal
shoal config   # update settings in existing .env (e.g. issue trackers)
```

On startup shoal prints which `.env` it loaded (or that it found none). If you see `0 variables injected`, you are not in the directory that contains `.env`.

**Or clone and develop locally:**

```bash
git clone https://github.com/m8i-51/shoal
cd shoal
npm install && npx playwright install chromium
cp .env.example .env   # set ANTHROPIC_API_KEY and BASE_URL
npm start
```

---

## Web dashboard

```bash
shoal serve        # global install
# or
npm run serve      # from cloned repo
```

Opens at `http://localhost:4000`. From there you can:

- **Start a run** — configure agent count, target URL, and custom instructions
- **Watch agents swim live** — the Swarm tab shows an animated real-time view of agents as they explore. When a finding is discovered, the agent's chip flashes with the finding title.
- **Review past runs** — findings by category, agent count, duration, and estimated cost
- **Generate an Agent Diary** — after a run completes, one LLM call turns the raw log into a story-style narrative of the exploration, readable by anyone on the team
- **Hall of Issues** — browse all findings across every run with full-text search and category filter. Export as JSON to share, or paste a GitHub raw/gist URL to import findings from other projects.
- **Edit app goals** — guide the goal-gap detector by defining what the app should achieve
- **Schedule a weekly run** — pick a day and time directly in the dashboard for automatic recurring runs (the `shoal serve` process must stay running; for a serverless alternative see [Scheduled runs](#scheduled-runs) below)

---

## Cross-run intelligence

shoal gets smarter with each run.

**Diff exploration** — after every browser navigation, shoal hashes the page content (SHA-256 of `innerText`). On the next run, agents that land on an unchanged page are nudged to move on: *"page content unchanged since last run — consider exploring a different area."* The hashes accumulate in `cache/page-hashes/` and steer future agents toward parts of the app that have actually changed.

**Finding hotspots** — the persona designer has access to a `get_finding_hotspots` tool that aggregates findings by URL area across all past runs. It uses this to recruit agents toward under-investigated parts of the app, or to send specialists into zones where problems keep clustering.

**Agent memory** — each persona remembers its own experience from the last few runs: what it struggled with, what it reported, what it accomplished. On the next run it returns as a *returning user* — first revisiting what frustrated it (confirming improvements, or re-reporting with "still broken since my last visit"), then moving on to new areas. Findings gain the continuity of a real user relationship.

**Returning-user sessions** — each browser agent's storage state (cookies, local storage) is saved per persona in `cache/sessions/` and restored on the next run. Agents come back to the app as the same user with the same session: still logged in, with the data they created last time. Scenario design includes one returning-user journey per run — resuming a draft, reviewing accumulated data — so lifecycle states (empty → populated, notifications, stale sessions) get tested the way real users hit them.

**Multi-actor scenarios** — real concurrency bugs live where two users touch the same data at the same time. When the Account Manager discovers two or more roles, the scenario designer creates one two-actor scenario per run — an admin revoking access while a user is mid-flow, two users editing the same record — and two browser agents play it out *simultaneously*. Each agent is paired to an actor by persona role (not roster order) and logged in as the matching test-account session, watching for stale data, silent overwrites, and permission changes that don't take effect mid-session.

**Swarm signals** — agents in the same run share a blackboard. A `check_swarm_signals` tool shows each agent what the others have just reported; when a signal matches the area an agent is in, it tries to reproduce the problem from its own perspective. Findings corroborated by multiple different personas merge into much stronger issues at triage.

**Environment personas** — a persona's environment is part of who they are. The persona designer can give recruits a real browsing environment — a phone (actual Playwright device emulation with touch and mobile viewport), a non-default locale, dark mode, reduced motion, or a slow 3G connection — matched to the persona's life. Mobile and accessibility findings come from actually experiencing the app in that environment, not from guessing. Browser agents also carry a `run_a11y_audit` tool (axe-core) that measures WCAG violations on the current page, so accessibility findings cite specific rules and elements as evidence.

**Adoption feedback** — when triage files an issue, shoal remembers which perspectives (lenses / scenarios) produced it. On later runs it checks how your team closed those issues — fixed counts as *adopted*, closed as not-planned counts as *rejected* — and feeds the adoption rates back into persona recruitment and scenario design. Perspectives whose findings the team acts on get recruited more; ones that keep getting rejected fade (but never disappear — a rejected finding may just be low priority).

**Experience Score** — a 0–100 health score of your app's user experience, tracked across runs. It blends three signals: scenario success rate (did agents accomplish realistic user tasks?), friction (how many steps it took), and regressions (did fixed bugs come back?). The score, its trend, and the delta against the previous run appear on the dashboard and at the top of each HTML report — so you can see at a glance whether the app is actually getting better.

All signals work passively — no configuration needed. They improve automatically as runs accumulate.

---

## Where config lives

shoal reads `.env`, `test-accounts/`, `shoal.config.ts`, and writes `logs/` / `findings/` from the **current working directory** — not from the global install location, and not automatically from a monorepo root.

On startup:

```
[env] working directory: /path/you/ran/from
[env] loaded /path/you/ran/from/.env (12 variables)
```

If that directory has no `.env`:

```
[env] no .env found at /path/you/ran/from/.env (0 variables injected)
```

With 0 injected variables, shoal falls back to the default LLM provider (Anthropic) with no API key, which then fails. Logs also go to the working directory, so it is easy to miss that a subdirectory config was never read.

**Putting config in a subdirectory** (typical in a monorepo):

```bash
mkdir -p apps/shoal
cd apps/shoal
shoal init                 # writes apps/shoal/.env
# add test-accounts/accounts.json here too
shoal serve                # dashboard; logs and findings land in apps/shoal/
```

Or stay at the repo root and point shoal at that directory:

```bash
shoal serve --dir apps/shoal
shoal --dir apps/shoal
# load a specific file but keep cwd for logs:
shoal serve --env-file apps/shoal/.env
```

`--dir` also changes where `test-accounts/`, `logs/`, `findings/`, and `shoal.config.ts` are resolved. `SHOAL_DIR` and `SHOAL_ENV_FILE` are the env-var equivalents.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TARGET` | `none` | Target config name (`example` \| `none` \| your custom name) |
| `BASE_URL` | `http://localhost:3000` | Target app URL |
| `MAX_EXPLORERS` | `4` | API explorer agent count (0 to disable) |
| `MAX_BROWSERS` | `2` | Browser agent count |
| `ANTHROPIC_API_KEY` | — | Required |
| `ISSUE_TRACKERS` | — | Comma-separated list of active trackers: `github`, `jira`, `notion`, `backlog`, `asana` |
| `SHOAL_MODE` | `safe` | Safety mode: `read-only` \| `safe` \| `full` (see below) |
| `SHOAL_TRACE` | `1` | Record Playwright traces of browser agent sessions (`0` to disable). Each finding gets a trace chunk at save time (`logs/traces/<run>/<findingId>.zip`); the agent session trace remains at `logs/traces/<run>/<agentId>.zip` |
| `REFRESH_SPEC` | — | Set to `1` to re-run product discovery |

**Safety modes** — agents write data as they explore, so choose how much they're allowed to touch:

- `read-only` — no writes at all. Mutation requests (POST/PUT/PATCH/DELETE) from browser agents are blocked at the network layer. Safe to point at production.
- `safe` (default) — creating and editing test data is fine, but agents are instructed to stop before irreversible actions: deleting records, payments, sending emails or invitations.
- `full` — no restrictions. Use only against disposable environments.

In `safe` and `read-only` modes, API tools marked `destructive: true` in your target config are removed from the agents' toolset. The mode can also be selected per run in the dashboard's start dialog.

**Issue tracker variables** (set only what you need):

| Tracker | Variables |
|---|---|
| GitHub Issues | `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/repo`) |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` |
| Notion | `NOTION_API_KEY`, `NOTION_DATABASE_ID` ¹ |
| Backlog | `BACKLOG_SPACE`, `BACKLOG_API_KEY`, `BACKLOG_PROJECT_ID` |
| Asana | `ASANA_ACCESS_TOKEN`, `ASANA_PROJECT_ID` |

¹ The Notion database must have `Name` (title), `Labels` (multi_select), and `Status` (select) properties.

Multiple trackers can be active at the same time — findings are posted to all of them. If `ISSUE_TRACKERS` is not set but `GITHUB_TOKEN` and `GITHUB_REPO` are present, GitHub is used automatically (backward compatible).

Backlog projects do not share issue type or priority IDs. On each filing, shoal fetches the project's type and priority lists, matches shoal categories (`bug` / `ux` / `feature-request` / `goal-gap`) to names such as バグ・要望・タスク / 高・中・低, and asks the LLM only when no name matches. The chosen type and priority are logged (`[backlog] selected issueType "バグ" (id=…) for category=bug`).

---

## Adding a target

shoal loads `shoal.config.ts` from the **current working directory** at startup. Two common setups:

**Option A — config in your project directory** (recommended)

```bash
# Copy the example from the repo (or create from scratch)
curl -O https://raw.githubusercontent.com/m8i-51/shoal/main/shoal.config.example.ts
mv shoal.config.example.ts shoal.config.ts
# Edit shoal.config.ts, then:
shoal
```

**Option B — config inside the cloned repo** (simplest for development)

```bash
cp shoal.config.example.ts shoal.config.ts
# edit shoal.config.ts, then:
npm start
```

`shoal.config.ts` exports a `target` object. For API explorer agents, include `appTools` and `execute`:

```typescript
// shoal.config.ts
export const target = {
  appTools: [
    { name: "list_items", description: "Get all items.", input_schema: { type: "object", properties: {}, required: [] } },
  ],
  async execute(toolName: string, input: Record<string, unknown>) {
    if (toolName === "list_items") {
      return fetch(`${process.env.BASE_URL}/api/items`).then(r => r.json());
    }
  },
};
```

Alternatively, copy `targets/example.ts`, register it in `targets/index.ts`, and set `TARGET=my-app`.

`appTools` and `execute` are required only for API explorer agents. Login does not depend on them: `test-accounts/accounts.json` is enough, and a config that only sets `credentials` (or `projectPath`) is still applied.

---

## MCP server — close the fix loop

shoal can act as an [MCP](https://modelcontextprotocol.io/) server, so coding agents like Claude Code can drive the full **find → fix → verify** loop:

```bash
shoal mcp   # stdio transport
```

Register it in your agent's MCP config (e.g. `.mcp.json`):

```json
{ "mcpServers": { "shoal": { "command": "shoal", "args": ["mcp"] } } }
```

Exposed tools:

| Tool | Purpose |
|---|---|
| `start_run` | Launch an exploration run (URL, agent counts, safety mode) |
| `get_run_status` | Poll progress: findings so far, regression results, log tail |
| `list_findings` | Read findings across runs, filtered by run / category / text |
| `verify_fix` | Spawn a single verifier agent that retraces one finding's flow and reports `fixed` / `still_broken` / `inconclusive` |
| `get_experience_score` | Cross-run Experience Score trend — did the fix actually improve the experience? |

A coding agent can pick a finding with `list_findings`, fix the code, redeploy, and call `verify_fix` to have an agent retrace the exact reported flow — closing the find → fix → verify loop without a human in the middle.

---

## PR Experience Diff

Get per-PR feedback on how a change *feels* to users, not just whether tests pass:

```bash
shoal diff                    # diff vs origin/main
shoal diff --base origin/dev  # diff vs any ref
```

`shoal diff` maps the PR's changed files to routes (Next.js pages/app router and `views/`/`routes/` conventions), sends a small focused swarm (2 browser agents by default) to those areas of your preview deployment, and posts a summary as a PR comment — findings, plus the Experience Score delta:

> **Experience Score: 72/100** (▲5 vs previous run)
> Agents focused on the areas this PR touches: `/checkout`
> 🐛 **[bug] Checkout button unresponsive** — Nadia
> I tapped the checkout button and nothing happened.

If `GITHUB_TOKEN` isn't available the summary is saved to `logs/diff_<runId>.md` instead. For CI, `shoal init`'s example lives at `.github/workflows/shoal-diff.example.yml` — it runs on every PR against your `PREVIEW_URL`.

---

## Scheduled runs

To run shoal weekly against a staging environment, add a GitHub Actions workflow to your repo.

Run `shoal init` — it will offer to generate `.github/workflows/shoal-weekly.yml` automatically. Or copy the example from this repo:

```bash
curl -O https://raw.githubusercontent.com/m8i-51/shoal/main/.github/workflows/shoal-weekly.example.yml
mv shoal-weekly.example.yml .github/workflows/shoal-weekly.yml
```

Then add `ANTHROPIC_API_KEY` to your repo's **Actions secrets** (`Settings → Secrets and variables → Actions`).

The workflow runs every Monday at 09:00 UTC and can also be triggered manually from the Actions tab. Findings are filed as GitHub Issues using the built-in `GITHUB_TOKEN`.

---

## shoal-bench

How well does the swarm actually detect problems? `bench/` ships **two sample apps** with seeded bugs and ground-truth labels:

| Variant | App | Seeded bugs | Labels file |
|---|---|---:|---|
| `store` (default) | Tiny store with cart/admin/nav | 7 | `bench/labels.json` |
| `forms` | Support ticket form | 3 | `bench/labels-forms.json` |

Each label includes `lens`, `path`, and `category` metadata for per-area scoring.

```bash
npm run bench                         # store variant
npm run bench:forms                   # forms variant
SHOAL_BENCH_MIN=60 npm run bench      # exit non-zero below 60% detection (CI regression gate)
BENCH_RECORD=1 npm run bench          # append model score to bench/scores.json
```

The scorer matches findings to labels and prints a detection report:

```
Detection rate: 5/7 (71%)
  ✓ cart-total-wrong
      └ "Cart total doesn't match item quantities"
  ✗ low-contrast (accessibility @ /) — The Buy button text is nearly the same color as its background
```

### Published detection scores

Scores recorded with `BENCH_RECORD=1` (see `bench/scores.json`):

| Variant | Model | Detection | Findings | Date | Config |
|---|---|---:|---:|---|---|
| store | claude-sonnet-4-20250514 | 71% | 11 | 2026-08-15 | MAX_BROWSERS=3, default prompts |

Use it as a regression test when changing prompts, models, or exploration logic — and don't fix the seeded bugs (the app's test suite pins them in place).

---

## Account Manager

For apps that require login, shoal includes an Account Manager agent that tests credentials and injects session state into explorer agents so they can reach authenticated routes.

Create `test-accounts/accounts.json` (gitignored) with your test credentials. That file alone is enough — `target.credentials` in `shoal.config.ts` is optional:

```json
[
  { "email": "test@example.com", "password": "testpassword", "role": "user" },
  { "email": "admin@example.com", "password": "adminpassword", "role": "admin" }
]
```

On startup shoal reads this file and runs Account Manager: it logs in with each account **on the login URL found during product discovery** (not only `BASE_URL`), saves Playwright session state, and passes those sessions to browser agents. If a seed admin is available (from `accounts.json` or `target.credentials`), it also explores user management and tries to create one test account per role.

If session injection fails, browser agents are **not** left to invent logins. They either receive the `accounts.json` credentials and the discovered login path, or they explore as a guest with an explicit instruction not to guess usernames or passwords.

Startup logs always report whether `accounts.json` was found, whether config credentials were set, and why Account Manager started or was skipped.

`shoal.config.ts` `appTools` and `execute` are required only for API explorer agents, not for login. A config that has `credentials` (or `projectPath`) but no tools still applies those fields.

---

## LLM providers

shoal defaults to Anthropic Claude. To use a different provider, set these variables in `.env`:

| Provider | Variables |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` |
| Amazon Bedrock | `LLM_PROVIDER=bedrock`, `AWS_REGION` (keys optional — default credential chain) |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| OpenRouter | `LLM_PROVIDER=openrouter`, `LLM_API_KEY`, `LLM_MODEL` |
| Groq | `LLM_PROVIDER=groq`, `LLM_API_KEY`, `LLM_MODEL` |
| Gemini | `LLM_PROVIDER=gemini`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex (ChatGPT subscription) | run `npm run auth:codex` once, then `LLM_PROVIDER=codex` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

### Amazon Bedrock

Leave `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **unset** to use the default AWS credential chain (shared credentials file, named profile, SSO cache, or instance role). You do not have to run `aws sso login` if the machine already has long-lived keys in the default profile — short-lived SSO login is often rejected in that situation. Use the existing keys (or a dedicated profile) instead.

**Do not** put empty `AWS_ACCESS_KEY_ID=` / `AWS_SECRET_ACCESS_KEY=` lines in `.env`. An empty value overrides the credential chain and authentication fails. shoal strips empty AWS keys at startup and logs a warning.

Set `LLM_MODEL` to a Bedrock model ID **or** an inference profile ID. Not every model generation is available for in-region invoke or for every geographic profile. If you need data to stay in-country, pick a generation that exists as a geo profile in that region:

| Scope | Example `LLM_MODEL` | Typical `AWS_REGION` |
|---|---|---|
| Foundation model (on-demand, when offered) | `anthropic.claude-3-5-haiku-20241022-v1:0` | region that hosts the model |
| US cross-region | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | `us-east-1` |
| EU cross-region | `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` | `eu-central-1` |
| APAC cross-region | `apac.anthropic.claude-sonnet-4-5-20250929-v1:0` | `ap-northeast-1` |
| Japan (Tokyo + Osaka only) | `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` | `ap-northeast-1` |
| Japan | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | `ap-northeast-1` |
| Japan | `jp.anthropic.claude-sonnet-4-6` | `ap-northeast-1` |

List profiles in your account with `aws bedrock list-inference-profiles`. Copy-paste examples live in `.env.example`.

---

## License

[MIT](LICENSE)
