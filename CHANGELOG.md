# Changelog

All notable changes to shoal are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and shoal aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — while the version
stays below `1.0.0`, minor-looking releases may still change behaviour.

Releases up to and including `0.1.33` are reconstructed after the fact from
commit messages, pull request numbers, and release dates. This repository's
commit history begins on 2026-08-14 (pull request #22) and does not reach back
to `0.1.20` or earlier, so those releases are not separately documented here.

## [Unreleased]

### Added

- **Retention for run artifacts.** `logs/screenshots/run_*` and
  `logs/traces/run_*` accumulated one directory per run forever, with nothing
  to clean them up. Every run now prunes directories older than
  `SHOAL_RETENTION_DAYS` (default 30, `0` disables it — a typo or
  out-of-range value warns and falls back to 30) at startup and logs how
  many it removed. Findings JSON, report HTML, and run logs are untouched.

### Fixed

- **Every navigation could hang for 30s on a page holding an open
  SSE/WebSocket connection.** Every `page.goto()` shoal issues — the
  `navigate` browser tool, agent session start, account-manager login/nav,
  product discovery — waited for `networkidle`, which never fires while a
  long-lived connection (an `EventSource`, a live-updating dashboard) keeps at
  least one network exchange open. Switched all of them to `waitUntil: "load"`
  with a 15s timeout (product discovery keeps its existing 10s timeout); the
  settle delays after each navigation (`RUN_TIMINGS.afterNavigateMs`, etc.)
  are unchanged.
- **A fatally failed run exited with code 0.** `main().catch(...)` in `run.ts`
  only set a non-zero exit code for `BudgetExceededError`; any other error
  (a browser-launch failure, a config error — anything that meant the run
  never actually started) was logged and the process still exited 0. That
  made the run indistinguishable from success to anything watching the exit
  code — the weekly workflow and `SHOAL_BENCH_MIN` gate previously could not
  detect a run that never started. `triage-only.ts` had the same gap.
  Both now set `process.exitCode = 1` on any fatal error.
- **`shoal serve` dying left orphaned swarms and "ghost" running runs.** The
  server had no `SIGTERM`/`SIGINT` handler, so killing it (a container
  restart, a deploy) left the spawned `run.ts` child process — and the real
  browser it launched — running with nobody watching it, and its
  `running_<id>.json` behind, which `listRuns()` took at face value and kept
  reporting that run as live forever after. The server now forwards
  `SIGTERM`/`SIGINT` to every unfinished session's child and waits up to 5s
  for those children to exit (SIGKILL after 4s) before `process.exit`, so
  the kill timer is not cancelled out from under the swarm. The child's pid
  is recorded in `running_<id>.json`, and `listRuns()` checks that pid's
  liveness — a dead pid is unlinked and no longer reported as running.
  `running_<id>.json` files from before this fix have no pid and keep the
  previous behaviour.
- **The dashboard failed shoal's own accessibility audit.** Running
  `framework/a11y-audit.ts` against the served dashboard found 11 violation
  types across `/`, `/hall`, and `/runs/:id`: unlabelled schedule hour/minute
  inputs, an empty table header, missing `<main>`/heading structure (no `<h1>`
  on the run detail page, a heading level skipped on the Hall page), and
  widespread text failing WCAG AA contrast (the muted secondary-text colour,
  several category/status badges, and disabled schedule controls that stayed
  focusable and readable at 40% opacity instead of being marked `disabled`).
  Fixed all of them — the same audit now reports zero violations on all three
  pages. Also removed five `outline: none` rules that left keyboard focus
  invisible on form controls with nothing in its place, replaced by one
  `:focus-visible` rule. The standalone HTML report (`framework/report.ts`,
  the artifact actually shared and opened outside the dashboard) had the
  same white-on-badge contrast problem in every one of its badge colours —
  category, finding/agent status, scenario/lens tags, and regression
  outcomes — and is now darkened to match, reusing the dashboard's category
  colours where the category is the same. Its foreground text colours had
  the identical problem — muted gray captions, the amber/green/red status and
  score text, and the violet scenario-ID label all fell below 4.5:1 against
  the backgrounds they actually render on (white cards, the light table
  header, the dark category bar) — and are now darkened the same way,
  checked pair-by-pair against their real background rather than assumed
  against plain white. `header .meta`, already correct as light text on the
  report's dark header bar, is untouched. Text inside a skipped finding card
  stays as-is: `.finding.skipped`'s reduced opacity is a deliberate
  de-emphasis this audit doesn't try to override.
- **Bench scoring matched keywords as bare substrings.** `findingMatchesLabel`
  used `text.includes(keyword)`, so an unrelated finding ("Although the page
  loads quickly... Totally fine otherwise.") was counted as detecting
  `missing-alt-text` (`alt` ⊂ `Although`) and `cart-total-wrong` (`total` ⊂
  `Totally`). Matching now requires word boundaries around each keyword
  (multi-word keywords like "no login" still match as a phrase). That
  boundary requirement in turn broke every keyword in `bench/labels.json`
  and `bench/labels-forms.json` that was a deliberate word *stem* relying on
  substring matching to catch several inflected forms at once —
  `"miscalculat"` (meant to catch "miscalculated"/"miscalculation"),
  `"auth"` ("authentication"), `"sum"` ("sums"), `"confirm"`
  ("confirmation"), `"label"` ("labels"), and `"stack trace"` ("stack
  traces") — so those labels are now spelled out as the actual word forms
  instead. Added `precision` (matched findings / total findings, `null` —
  printed as "n/a", omitted from `bench/scores.json` — for a run with zero
  findings rather than a misleading 0%) alongside the existing
  `unmatchedFindings`, recorded in `bench/scores.json` entries and shown in
  the README's published-scores table; the one existing row predates both the
  boundary fix and these fields, so its new columns read "—" with a footnote.
- **`framework/cost.ts` priced OpenAI models by exact match only.**
  `gpt-4o-mini-2024-07-18` (a dated snapshot) matched nothing and was priced
  as unknown (excluded from `SHOAL_MAX_USD` accounting) instead of falling
  back to `gpt-4o-mini`, the way the Anthropic pricing table already falls
  back for dated Claude model IDs. OpenAI, Anthropic, and Bedrock now share
  one longest-prefix lookup, so the most specific matching entry always wins
  regardless of key order. Bedrock previously used the first table key that
  *either* prefixed or was prefixed by the model id, so a short id like
  `anthropic.claude-opus-4` could steal `anthropic.claude-opus-4-8` pricing.
- **A browser agent's system prompt said "finish after 8-10 actions" no
  matter what `SHOAL_BROWSER_ITERATIONS` / `SHOAL_THRESHOLD_ITERATIONS` were
  actually set to** (default 12). Both prompts now interpolate the real turn
  budget.
- **Starting a second run while one was already in progress** silently
  spawned a second `run.ts` child process competing for the same browser and
  `logs/`/`findings/` files. `POST /api/runs/start` now returns 409, and the
  `start_run` MCP tool now throws, while another run is still active. The
  weekly scheduler had the same gap — it fires unattended, so it is the
  likeliest way to hit this — and now skips the scheduled run with a log
  line when one is already active, recording `pendingDate` for today so a
  later tick the same day retries once the in-flight run finishes, rather
  than missing the week because a swarm outlasts the two-minute fire window.
- **An LLM-written issue body or comment could `@mention` a real GitHub user
  or team.** Every path that hands model-written text to a tracker now wraps
  `@word` in backticks: triage `create_issue` (the body *and* the `edge_risk`
  edge/why fields), returning-user re-report comments, and the regression
  agent's `report_regression` / `mark_verified` (issue body, comment, and
  the original issue title interpolated into the new issue body). A mention
  in a comment on an existing issue notifies every subscriber of that issue,
  not just the mentioned account. Issue titles themselves are left alone —
  GitHub renders them as plain text and does not notify on a mention there.
- `schedule.json` (written by the dashboard scheduler to the working
  directory) is now gitignored.

### Security

- **`safe` mode's destructive-click guard was English-only.** `DESTRUCTIVE_CLICK_PATTERNS`
  only matched English phrasing, so a Japanese UI (`削除`, `購入する`) passed straight
  through the click-level guard in `safe` mode. Added a matching set of Japanese
  patterns (delete, purchase, payment, cancellation, unrecoverable actions, etc.,
  deliberately excluding a bare `送信` so ordinary form submits still work), plus
  `SHOAL_DESTRUCTIVE_PATTERNS` so operators can append their own regexes — invalid
  entries are skipped with a warning rather than crashing the run.
- **A dashboard token holder could exfiltrate the operator's LLM API key.**
  `POST /api/runs/start` accepted a caller-supplied `llmBaseUrl` while the
  spawned run inherited the server's own `LLM_API_KEY`/`OPENAI_API_KEY` from
  its environment, and the OpenAI-compatible client sent that inherited key
  as a Bearer token to whatever URL the caller supplied — pointing
  `llmBaseUrl` at an attacker-controlled server leaked the operator's real
  key. `llmBaseUrl` without `llmApiKey` is now rejected with 400, and
  whenever `llmBaseUrl` is set, the spawned run's environment has the
  server's own `LLM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`,
  `LLM_BASE_URL`, and `LLM_PROVIDER` stripped before the caller's own
  values are applied, so only the caller's key can ever reach the caller's
  URL. Tracker tokens stay — the child still has to file issues.
- **The run-detail report `<iframe>` had no `sandbox`.** `framework/report.ts`
  generates plain HTML with no `<script>`, so the frame now gets `sandbox=""`
  — no script capability, and critically, never `allow-same-origin`.
- **Playwright traces held typed passwords in plaintext.** `tracing.start({
  snapshots: true })` records every value a `fill()` writes into the page —
  including a password typed during login — inside `trace.trace` /
  `*.network` entries of the saved zip, even though redact.ts already masked
  the same value in console output, run JSON, and the HTML report. Every
  trace zip (each lane's full-session trace and each finding's trace chunk)
  is now scrubbed in place immediately after it is written: known test-account
  passwords and target credentials are registered up front, and any value
  typed into a field detected as a password is added as it happens. A scrub
  failure only logs a warning and never fails the run.
- **"read-only — safe to point at production" undersold what still leaves the
  machine.** `SHOAL_MODE=read-only` only blocks writes to the target app —
  everything agents read (page text, accessibility tree, console/network
  output, screenshots) is still sent to the configured LLM provider. Reworded
  the safety-mode docs (README, README_JA, SECURITY.md, `.env.example`, the
  dashboard's start-dialog hint) to say so, and added a
  [What is sent to the LLM provider](SECURITY.md#what-is-sent-to-the-llm-provider)
  section spelling out exactly what leaves the machine and what controls
  where it goes.

### Changed

- **`@anthropic-ai/claude-agent-sdk` was a hard dependency for everyone, used
  only by `LLM_PROVIDER=claude-cli`.** It is ~200MB of a ~378MB production
  install (measured with `npm pack` + `npm install --omit=dev`) and carries
  Anthropic's own licence, not an OSI-approved one ("SEE LICENSE IN
  README.md"). It is now an optional `peerDependency` (kept in
  `devDependencies` too, so tests and local dev are unaffected) and is
  imported dynamically only when `runClaudeCliSession` actually runs; every
  other provider now installs without it. A measured production install
  dropped from 378MB to 168MB. Using `claude-cli` without the package
  installed now fails with a clear message telling you to
  `npm install @anthropic-ai/claude-agent-sdk`.

## [0.2.1] — 2026-09-03

### Added

- **Triage results reach the dashboard.** Every reader of `findings/` skipped
  `triage_result.json` by name, so the step that decides what the team actually
  receives left no trace in the UI. Triage now records each issue as it files it
  — the findings merged into it, the tracker URL, the edge-risk call and its
  reason, and why a finding was skipped — and a Triage tab on the run detail
  page (`GET /api/runs/:runId/triage`) shows it. A declared product edge and the
  tickets it flagged are finally visible in the same place. Results written
  before this carry ID lists only; they still load, labelled as such.
- **Finding adoption panel.** `coverage/adoption.json` — how many filed issues
  the team fixed versus closed as *not planned* — already steered persona hiring
  and scenario design, but had no API and no UI. `GET /api/adoption` and a
  dashboard panel now show the overall rate, the breakdown by lens and category,
  what is still open, and the most recently resolved issues.
- **Cross-run LLM cost.** Cost was per-run only. The dashboard now shows
  cumulative spend, the per-run average, the last 30 days, total input/output
  tokens, and a per-run trend, derived from `/api/runs` (which now also carries
  token counts). Runs with no estimate are excluded from the total and counted
  separately rather than silently understating it.
- **Product Edge — a declared answer to "fix everything and the product goes
  flat".** A product can now state what it is deliberately sharp about
  (`sharpEdges`) and what it gives up to stay that way (`tradeoffs`). Product
  discovery drafts it from the app; the dashboard's Product Edge panel and
  `PATCH /api/spec/edge` let the team declare their own, and a declared edge is
  kept when discovery runs again instead of being overwritten by a fresh
  inference.
- **`edge-risk` tickets.** With an edge declared, triage still files every
  finding — nothing is dropped or softened — but labels an issue `edge-risk`
  when the obvious fix would blunt a declared edge, and writes the edge at stake
  and what would be lost into the ticket body. Flagged findings are reported in
  `TriageResult.edgeRisks` and `triage_result.json`. Findings categorised as
  `bug` can never be marked this way, and with no edge declared the mechanism
  stays off entirely.

### Security

- **`SHOAL_ALLOWED_HOSTS`, for the recommended reverse-proxy setup.** Putting a
  TLS-terminating proxy in front of a loopback-bound dashboard — exactly what
  SECURITY.md recommends — used to fail outright: a proxy that preserves the
  `Host` header sent one shoal didn't recognise (403 `host not allowed`), and
  one that rewrites `Host` to shoal's own address still forwarded the
  browser's real `Origin` unchanged, which then failed to match (403
  `cross-origin request refused`). Setting `SHOAL_ALLOWED_HOSTS` to the
  proxy's public hostname fixes both checks, and — like a non-loopback
  `SHOAL_HOST` — makes a dashboard token mandatory, since the dashboard is
  reachable from the network either way.
- **`?token=` is no longer a standing credential on `/api` calls.** It was
  documented as a bootstrap-only mechanism (exchanged for an `HttpOnly`
  session cookie on first use) but was still accepted directly on every
  `/api` request afterwards, which put it in server logs and browser history
  as a reusable credential. Only the cookie, or an `Authorization`/
  `X-Shoal-Token` header, authenticates `/api` calls now; the query
  parameter still works exactly once, to establish the cookie.
- **`shoal init` now writes `.env` with `0600` permissions**, not the default
  `0644` — it holds API keys and tracker tokens in plain text, and the old
  permissions left it world-readable on a shared machine. `shoal config`
  re-tightens permissions on an existing `.env` it updates, too.
- Fixed a `fast-uri` transitive dependency vulnerability (via
  `@modelcontextprotocol/sdk` → `ajv`) with a version override; `npm audit`
  is clean again.

### Fixed

- **Amazon Bedrock's default model was retired.**
  `anthropic.claude-3-5-haiku-20241022-v1:0` — used whenever
  `LLM_PROVIDER=bedrock` was set without an explicit `LLM_MODEL` — no longer
  exists. The default is now `anthropic.claude-haiku-4-5-20251001-v1:0`.
  OpenRouter's default moved off a retired Gemini 1.5 generation to
  `google/gemini-2.0-flash-001`. Both defaults now live in one place
  (`framework/llm-client.ts`'s `PROVIDER_DEFAULT_MODELS`), cross-checked by a
  test against `bin/init.js`'s copy of the same table, so the next retirement
  can't silently drift between the two again.
- **`shoal init`'s generated weekly-run workflow had drifted from the shipped
  example.** It still hardcoded Node 20 and `actions/checkout@v4` /
  `actions/setup-node@v4` after both the repo's own CI and
  `shoal-weekly.example.yml` moved to Node 22 and `@v7`. It's now generated
  from that same example file instead of a second hand-written copy, so the
  two can't diverge again.
- **LLM calls only retried on HTTP 429.** A 529 (Anthropic's "overloaded"),
  a 5xx from the provider or an intermediary, or a dropped connection failed
  the whole agent immediately instead of retrying. All of those now retry
  with the same backoff as 429. Also fixed: a `retry-after` header in
  HTTP-date form (RFC 7231's other allowed format, as opposed to a plain
  number of seconds) was parsed with `parseInt`, which returns `NaN` for a
  date string — the run waited `NaN` ms, in practice retrying immediately
  instead of honoring the provider's requested delay.
- **`shoal-bench`'s `BENCH_RECORD=1` always recorded the model as `"unknown"`.**
  It read `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `SHOAL_MODEL`, none of which
  shoal itself ever sets (the real variable is `LLM_MODEL`, selected via
  `LLM_PROVIDER`). It now reads the same `provider`/`defaultModel` shoal's
  own LLM client resolves to.
- **GitHub issue/regression lookups were capped at one page** (20 closed
  issues, 50 open issues) with no way to see more, which silently limited
  regression checking and triage deduplication on any repo whose
  `feedback-agent`-labeled issues outgrew that page. Both now paginate
  through up to 1,000 issues. Also switched to the current `Authorization:
  Bearer` scheme (matching the rest of the GitHub tracker), and a malformed
  JSON response body is now handled instead of throwing.
- **A long-running `shoal serve`'s memory grew without bound.** Every run
  spawned from the dashboard stayed in `activeSessions` — logs, listeners,
  and all — forever, which matters for the weekly-scheduler use case the
  dashboard itself supports. A finished session is now evicted from memory
  30 minutes after it completes; every endpoint that reads a session already
  falls back to its log file when it isn't in memory, so nothing is lost.
- `POST /api/runs/start` now validates `maxBrowsers` / `maxExplorers` /
  `maxThresholds` (integers, 0–8) the same way the MCP `start_run` tool
  already did, rejecting anything else with `400` instead of passing it
  through to the spawned run's environment.

### Changed

- `run.ts` can now be imported without launching a real Playwright browser
  and agent swarm — it had no `NODE_ENV=test` guard around its top-level
  `main()` call (unlike `server/index.ts` and `server/mcp.ts`), which is part
  of why it had no test coverage at all.
- CI now runs `npm run test:coverage` instead of `npm test`, so the coverage
  thresholds already declared in `vitest.config.ts` are actually enforced
  rather than just aspirational.
- `.env.example`'s comments are now in English, matching CONTRIBUTING.md's
  policy for anything a user reads first — it was previously Japanese-heavy
  despite shipping in the npm package as the first file `shoal init` pairs
  with.
- Documented the `codex` provider's Terms note (README/README_JA), matching
  the one `claude-cli` already had: unlike `claude-cli`, it reads and
  refreshes OAuth tokens from `~/.codex/auth.json` directly and calls
  ChatGPT's undocumented backend endpoint itself, an integration pattern
  OpenAI has not published or endorsed.
- Added `CODE_OF_CONDUCT.md` (Contributor Covenant) and `.nvmrc`; CI and the
  publish workflow now read the Node version from `.nvmrc` instead of a
  separate hardcoded value. `package.json` now declares `license`,
  `keywords`, `homepage`, and `bugs` for npm and GitHub's own metadata
  surfaces. The publish workflow now runs lint and the type check before
  publishing, matching CI.

## [0.2.0] — 2026-09-02

### Security

- **The dashboard now binds to `127.0.0.1` by default.** It previously bound
  every interface, leaving `POST /api/runs/start` — which spawns a run against a
  caller-supplied URL and LLM endpoint — open to anyone who could reach the
  machine. Set `SHOAL_HOST` to expose it deliberately.
- **A token is required whenever the dashboard is not on loopback.** Set
  `SHOAL_TOKEN`, or one is generated and printed at startup. The API accepts it
  as `Authorization: Bearer`, `X-Shoal-Token`, or a `?token=` bootstrap URL.
- **Host and Origin checks on every request**, closing DNS rebinding against a
  loopback-bound dashboard and cross-site calls from another open tab.
- **A non-loopback bind is refused unless `SHOAL_ALLOW_INSECURE=1` is set.** The
  listener is plain HTTP, so `SHOAL_HOST=0.0.0.0` in a container spec used to
  serve the token in cleartext with only a log line to say so. Exposure is now
  an explicit decision; shoal still leaves TLS to a reverse proxy.
- **The dashboard token never reaches page JavaScript.** The `?token=…` URL is
  exchanged for an `HttpOnly; SameSite=Strict` session cookie, so an XSS on the
  dashboard origin cannot read the token and reuse it elsewhere, and no
  subsequent request carries it in a URL. shoal warns at startup when an exposed
  listener is plain HTTP.
- **Content from the target app is now fenced before it reaches an agent.** Page
  text, accessibility trees, console output, network errors, DOM diffs, a11y
  audits, swarm signals, and API tool results are wrapped in an untrusted-content
  block, and the agents are told that anything inside it is data, never
  instructions. Attempts to forge the fence are neutralised. See
  [SECURITY.md](SECURITY.md#prompt-injection-from-the-target-app).

### Added

- `SHOAL_MAX_USD` — a hard spend cap. The estimated cost is tracked as responses
  come back; once the cap is reached no further LLM call starts, remaining lanes
  are skipped, and findings already collected are still saved and reported. The
  cap is re-checked before every attempt, so a retry after a long 429 backoff
  cannot slip past it. Pricing that is fetched at runtime (OpenRouter) is loaded
  before the first call; when a model cannot be priced at all, shoal says the cap
  is unenforceable rather than silently counting nothing.
- ESLint (`npm run lint`), wired into CI ahead of the type check.
- `.editorconfig` and a Dependabot config for weekly version updates (security
  updates were already on; version updates were not).
- Env overrides for values that used to be literals in `run.ts`:
  `SHOAL_BROWSER_ITERATIONS`, `SHOAL_THRESHOLD_ITERATIONS`,
  `SHOAL_EXPLORER_CONCURRENCY`, `SHOAL_VIEWPORT`.
- This changelog, and GitHub Releases generated on publish.

### Changed

- `run.ts` split into `framework/browser-tools.ts` (the browser tool layer),
  `framework/agent-tools.ts` (tool schemas), and `framework/run-config.ts`
  (timings and limits). The tool layer takes its collaborators through a context
  object, so it is now unit-tested rather than reachable only through a live run.
- **The minimum supported Node.js version is now 22.** The openai SDK (v7) and
  `concurrently` (v10) both declare `engines: node >= 22`, and the release build
  already ran on 22; CI, the example workflows, and `package.json` now say so
  too. Node 20 is no longer tested.

## [0.1.33] — 2026-08-28

### Fixed

- Session fallback, password redaction, and lane-aware regression checks (#63).
- Persona seed input no longer fires creation on an IME confirmation Enter (#60).

### Added

- Site Map Coverage panel in the dashboard (#61).

## [0.1.32] — 2026-08-28

### Fixed

- Cost calculation for Bedrock Claude 4.x models and inference profiles (#57).
- Backlog regression comments use the issue key form (`XXX-55`) (#58).

### Changed

- Replaced the "grumpy uncle" persona example with a neutral first-time user (#56).

## [0.1.31] — 2026-08-27

### Added

- Threshold agent lane for boundary probing (#50).
- Fixed persona roster, generated from dashboard seeds (#51).
- Site Map Memory for path-level coverage (#52).
- Claude CLI provider, for use with a Claude Code subscription (#54).

## [0.1.30] — 2026-08-27

### Fixed

- `appGoals` are kept as outcomes rather than UI checklists (#48).

## [0.1.29] — 2026-08-27

### Fixed

- Incomplete personas are rejected; empty roles are tolerated (#46).

## [0.1.28] — 2026-08-27

### Fixed

- Multi-actor sessions match roles, and clicks resolve by name or ref (#44).

## [0.1.27] — 2026-08-27

### Fixed

- Account Manager treats an established session as a successful login (#42).

## [0.1.26] — 2026-08-27

### Fixed

- RunLog and memory recording for browser agents (#40).

## [0.1.25] — 2026-08-26

### Fixed

- Login uses the URL found during product discovery, and agents stop guessing
  credentials when session injection fails (#37).
- Diary paths are contained, closing CodeQL path-injection alerts (#38).
- The publish step parses `npm 12 pack --json` (#35).

## [0.1.24] — 2026-08-26

### Fixed

- First-run configuration guidance, and automatic Backlog issue-type selection (#32).
- Account Manager is seeded from `test-accounts/accounts.json` (#33).

## [0.1.23] — 2026-08-26

### Security

- The findings URL proxy allowlists GitHub hosts (SSRF) (#27).

### Changed

- OSS hardening: package contents, quieter example CI, community docs (#31).

## [0.1.22] — 2026-06-25

### Fixed

- Guard against the OpenAI SDK rejecting an empty `apiKey`.

### Added

- Documentation for the dashboard's built-in weekly scheduler.

[Unreleased]: https://github.com/m8i-51/shoal/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/m8i-51/shoal/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/m8i-51/shoal/compare/v0.1.33...v0.2.0
[0.1.33]: https://github.com/m8i-51/shoal/compare/v0.1.32...v0.1.33
[0.1.32]: https://github.com/m8i-51/shoal/compare/v0.1.31...v0.1.32
[0.1.31]: https://github.com/m8i-51/shoal/compare/v0.1.30...v0.1.31
[0.1.30]: https://github.com/m8i-51/shoal/compare/v0.1.29...v0.1.30
[0.1.29]: https://github.com/m8i-51/shoal/compare/v0.1.28...v0.1.29
[0.1.28]: https://github.com/m8i-51/shoal/compare/v0.1.27...v0.1.28
[0.1.27]: https://github.com/m8i-51/shoal/compare/v0.1.26...v0.1.27
[0.1.26]: https://github.com/m8i-51/shoal/compare/v0.1.25...v0.1.26
[0.1.25]: https://github.com/m8i-51/shoal/compare/v0.1.24...v0.1.25
[0.1.24]: https://github.com/m8i-51/shoal/compare/v0.1.23...v0.1.24
[0.1.23]: https://github.com/m8i-51/shoal/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/m8i-51/shoal/compare/v0.1.21...v0.1.22
