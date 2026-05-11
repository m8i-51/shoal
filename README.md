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
                       ▼  deduplicates and files GitHub Issues
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

Findings are filed as GitHub Issues or saved as a self-contained HTML report. A **web dashboard** lets you start runs, watch live progress, review findings by category, and track estimated LLM cost per run.

---

## Quick Start

**Install globally:**

```bash
npm install -g @m8i-51/shoal
npx playwright install chromium
```

Move to the project you want to explore, then run:

```bash
cd your-project
shoal init     # creates .env with all available options
```

Open `.env` and set at minimum:

```env
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:3000   # URL of the app to explore
```

Then run:

```bash
shoal serve    # open web dashboard at http://localhost:4000
shoal          # or run agents directly from the terminal
```

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
- **Monitor live progress** — watch agents explore and file findings in real time
- **Review past runs** — findings by category, agent count, duration, and estimated cost
- **Edit app goals** — guide the goal-gap detector by defining what the app should achieve

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TARGET` | `none` | Target config name (`example` \| `none` \| your custom name) |
| `BASE_URL` | `http://localhost:3000` | Target app URL |
| `MAX_EXPLORERS` | `4` | API explorer agent count (0 to disable) |
| `MAX_BROWSERS` | `2` | Browser agent count |
| `ANTHROPIC_API_KEY` | — | Required |
| `GITHUB_TOKEN` | — | Optional — enables Issue creation |
| `GITHUB_REPO` | — | `owner/repo` format |
| `REFRESH_SPEC` | — | Set to `1` to re-run product discovery |

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

`shoal.config.ts` must export a `target` object with two fields:

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

## Account Manager

For apps that require login, shoal includes an Account Manager agent that autonomously discovers and tests authentication. It finds login pages, tests credentials from `test-accounts/` (gitignored), and injects session state into explorer agents so they can reach authenticated routes.

Create `test-accounts/accounts.json` with your test credentials:

```json
[
  { "email": "test@example.com", "password": "testpassword", "role": "user" },
  { "email": "admin@example.com", "password": "adminpassword", "role": "admin" }
]
```

---

## LLM providers

shoal defaults to Anthropic Claude. To use a different provider, set these variables in `.env`:

| Provider | Variables |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| OpenRouter | `LLM_PROVIDER=openrouter`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex (ChatGPT subscription) | run `npm run auth:codex` once, then `LLM_PROVIDER=codex` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

See `.env.example` for full examples.

---

## License

[MIT](LICENSE)
