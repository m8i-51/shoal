# Contributing to shoal

Thanks for your interest in improving shoal! This guide covers how to set up a
development environment, run the checks, and submit changes.

> 日本語での Issue / PR も歓迎します（English もしくは日本語のどちらでも構いません）。

## Language

shoal is developed bilingually, with one rule so that neither audience is shut
out:

- **English** for anything a user or a new contributor reads first: the README,
  `SECURITY.md`, this file, ADR titles, exported symbol names, and the
  descriptions of tools and prompts sent to the LLM.
- **English or Japanese** for inline comments, commit messages, PR descriptions,
  and test names. Much of the existing code comments in Japanese; matching the
  file you are editing is always acceptable.

If a comment explains something a reader must understand to change the code
safely — an invariant, a security boundary, a non-obvious ordering requirement —
write it in English, wherever it sits.

## Prerequisites

- **Node.js 20+** (CI runs on Node 20; the release build uses Node 22)
- **npm** (the repo ships a `package-lock.json`)
- A supported LLM provider key if you want to run agents end-to-end — Anthropic
  by default. See the [LLM providers](README.md#llm-providers) table for
  alternatives (OpenAI, Bedrock, Groq, Gemini, OpenRouter, Ollama, LM Studio).

## Getting started

```bash
git clone https://github.com/m8i-51/shoal
cd shoal
npm install
npx playwright install chromium   # browser agents drive a real Chromium
cp .env.example .env              # set ANTHROPIC_API_KEY and BASE_URL
```

## Running locally

| Command | What it does |
|---|---|
| `npm run dev` | Dashboard dev mode — API server (`:4000`) + Vite web UI (`:5173`) with hot reload |
| `npm run serve` | Serve the API + prebuilt web dashboard at `http://localhost:4000` |
| `npm start` | Run the agent swarm from the terminal |
| `npm run triage` | Triage-only mode |
| `npm run bench` | Run the swarm against the seeded bench app and score detection |

To develop the web dashboard, `npm run dev` is usually what you want.

## Checks (please run before opening a PR)

```bash
npm run lint         # eslint (same as CI); `npm run lint:fix` fixes the easy ones
npx tsc --noEmit     # type check (same as CI)
npm test             # vitest — the full unit/integration suite
npm run build:web    # ensure the web bundle still builds
```

CI (`.github/workflows/ci.yml`) runs lint, the type check, the test suite, and
the web build on every pull request, so running these locally first saves a
round trip.

There is no formatter. Match the style of the file you are editing;
`.editorconfig` covers indentation and line endings.

## Tests

- Tests live next to the code they cover in `__tests__/` directories and use
  [Vitest](https://vitest.dev/).
- Add or update tests when you change behavior. `npm run test:watch` is handy
  during development, and `npm run test:coverage` reports coverage.
- **Do not "fix" the seeded bugs in `bench/`.** They are intentional
  ground-truth defects used to measure the swarm's detection rate, and the bench
  test suite pins them in place.

## Commit and PR guidelines

- This repo follows [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, …). Keep each commit focused on one
  logical change.
- For non-trivial features, add or update an ADR under [`docs/design/`](docs/design/)
  (see [`docs/README.md`](docs/README.md)). Keep implementation checklists in the PR
  description — not in the repo.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything
  a user would notice: behaviour changes, new options, security fixes. Pure
  refactors and internal test changes do not need one.
- Keep pull requests small and scoped. Fill out the PR template and describe how
  you tested the change.
- PRs are automatically reviewed by [CodeRabbit](https://coderabbit.ai/) in
  addition to a human maintainer.
- By contributing, you agree that your contributions are licensed under the
  project's [MIT License](LICENSE).

## Reporting bugs and requesting features

Please use the [issue templates](https://github.com/m8i-51/shoal/issues/new/choose).
For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).
