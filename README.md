[日本語版はこちら](README_JA.md)

# shoal

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-browser-45ba4b?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-blueviolet?logo=anthropic&logoColor=white)](https://www.anthropic.com/)

Point it at any web app. Agents explore it and file GitHub Issues.

shoal drops a swarm of agents onto a web app. Each agent has a distinct persona and evaluation lens — accessibility, security, business logic, data integrity, new user experience. They explore independently via API and real browser, then a triage agent deduplicates findings and files GitHub Issues.

No test scripts. No test data. No prior knowledge of the app required.

---

## How it works

```
Target App (any URL)
        │
        ▼  autonomously learns what the app does
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

---

## Quick Start

```bash
git clone https://github.com/m8i-51/shoal
cd shoal
npm install && npx playwright install chromium
cp .env.example .env   # set ANTHROPIC_API_KEY and BASE_URL
npm start
```

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

---

## Adding a target

shoal loads `shoal.config.ts` from the **current working directory** at startup. Two common setups:

**Option A — config inside the shoal repo** (simplest)

```bash
cp shoal.config.example.ts shoal.config.ts
# edit shoal.config.ts, then:
npm start
```

**Option B — config in your project directory** (keeps shoal untouched)

```bash
cp /path/to/shoal/shoal.config.example.ts ./shoal.config.ts
# edit shoal.config.ts, then run shoal from your project root:
BASE_URL=http://localhost:3000 npm start --prefix /path/to/shoal
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

## LLM providers

shoal defaults to Anthropic Claude. To use a different provider, set these variables in `.env`:

| Provider | Variables |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex (ChatGPT subscription) | run `npm run auth:codex` once, then `LLM_PROVIDER=codex` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

See `.env.example` for full examples.
