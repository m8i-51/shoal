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
npm run run
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

Copy `targets/example.ts`, implement two things: a tool list and an API executor. Register it in `targets/index.ts`, then set `TARGET=my-app`.

```typescript
export const myAppConfig: TargetConfig = {
  appTools: [
    { name: "get_items", description: "Get items from the app.", input_schema: { ... } },
  ],
  async execute(toolName, input, agentId) {
    // call your app's API
  },
};
```
