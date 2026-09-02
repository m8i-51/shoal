# Changelog

All notable changes to shoal are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and shoal aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — while the version
stays below `1.0.0`, minor-looking releases may still change behaviour.

Releases up to and including `0.1.33` are reconstructed from the git history;
entries for `0.1.20` and earlier live in the commit log only.

## [Unreleased]

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

[Unreleased]: https://github.com/m8i-51/shoal/compare/v0.1.33...HEAD
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
