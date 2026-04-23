[English version here](README.md)

# shoal

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-browser-45ba4b?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-blueviolet?logo=anthropic&logoColor=white)](https://www.anthropic.com/)

URLを渡すだけで、エージェントがアプリを探索してGitHub Issueを起票する。

shoalは複数のエージェントをWebアプリに送り込む。各エージェントは固有のペルソナと評価観点（アクセシビリティ・セキュリティ・ビジネスロジック・データ整合性・新規ユーザー）を持ち、APIとブラウザの両方から独立して探索する。その後、トリアージエージェントが重複を除去してGitHub Issueを作成する。

テストスクリプト不要。テストデータ不要。アプリの事前知識も不要。

---

## 仕組み

```
対象アプリ (任意のURL)
        │
        ▼  UIと公開情報からアプリを自律的に把握
  プロダクト理解
        │
        ▼  そのアプリに適したエージェント構成を生成
  組織設計
        │
        ▼  エージェントのペルソナを管理・更新
  人事エージェント
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
  APIエージェント ×N               ブラウザエージェント ×N
  APIで探索                        実際のUIをブラウズ
        │                                  │
        └──────────────┬───────────────────┘
                       ▼  重複除去してGitHub Issueを起票
                 トリアージ
```

---

## クイックスタート

```bash
git clone https://github.com/m8i-51/shoal
cd shoal
npm install && npx playwright install chromium
cp .env.example .env   # ANTHROPIC_API_KEY と BASE_URL を設定
npm start
```

---

## 設定

| 変数 | デフォルト | 説明 |
|---|---|---|
| `TARGET` | `none` | ターゲット設定名（`example` \| `none` \| カスタム名） |
| `BASE_URL` | `http://localhost:3000` | 対象アプリのURL |
| `MAX_EXPLORERS` | `4` | APIエージェントの最大数（0で無効化） |
| `MAX_BROWSERS` | `2` | ブラウザエージェントの最大数 |
| `ANTHROPIC_API_KEY` | — | 必須 |
| `GITHUB_TOKEN` | — | 任意（Issue作成に使用） |
| `GITHUB_REPO` | — | `owner/repo` 形式 |

---

## ターゲットの追加

shoalは起動時に**カレントディレクトリ**から `shoal.config.ts` を読み込む。2通りの使い方がある:

**パターンA — shoalリポジトリ内に置く**（シンプル）

```bash
cp shoal.config.example.ts shoal.config.ts
# shoal.config.ts を編集して npm start
npm start
```

**パターンB — 自分のプロジェクトに置く**（shoalを触らずに済む）

```bash
cp /path/to/shoal/shoal.config.example.ts ./shoal.config.ts
# shoal.config.ts を編集し、プロジェクトのルートから実行:
BASE_URL=http://localhost:3000 npm start --prefix /path/to/shoal
```

`shoal.config.ts` は `target` オブジェクトをエクスポートする:

```typescript
// shoal.config.ts
export const target = {
  appTools: [
    { name: "list_items", description: "アイテム一覧を取得する。 / Get all items.", input_schema: { type: "object", properties: {}, required: [] } },
  ],
  async execute(toolName: string, input: Record<string, unknown>) {
    if (toolName === "list_items") {
      return fetch(`${process.env.BASE_URL}/api/items`).then(r => r.json());
    }
  },
};
```

あるいは、`targets/example.ts` をコピーして `targets/index.ts` に登録し、`TARGET=my-app` で起動する方法もある。

---

## LLMプロバイダ

デフォルトはAnthropic Claude。別のプロバイダを使う場合は `.env` に設定する:

| プロバイダ | 変数 |
|---|---|
| Anthropic（デフォルト） | `ANTHROPIC_API_KEY` |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex（ChatGPTサブスク） | `npm run auth:codex` を一度実行後、`LLM_PROVIDER=codex` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

詳細は `.env.example` を参照。
