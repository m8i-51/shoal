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
npm run run
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

`targets/example.ts` をコピーして、ツール定義とAPIの実行ハンドラを書く。`targets/index.ts` に登録して `TARGET=my-app` で起動。

```typescript
export const myAppConfig: TargetConfig = {
  appTools: [
    { name: "get_items", description: "アイテム一覧を取得する。 / Get items.", input_schema: { ... } },
  ],
  async execute(toolName, input, agentId) {
    // アプリのAPIを呼ぶ
  },
};
```
