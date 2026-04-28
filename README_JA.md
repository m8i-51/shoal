[English version here](README.md)

# shoal

[![npm](https://img.shields.io/npm/v/@m8i-51/shoal?color=red)](https://www.npmjs.com/package/@m8i-51/shoal)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-browser-45ba4b?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-blueviolet?logo=anthropic&logoColor=white)](https://www.anthropic.com/)

URLを渡すだけで、エージェントがアプリを探索してGitHub Issueを起票する。

shoalは複数のエージェントをWebアプリに送り込む。各エージェントは固有のペルソナと評価観点（アクセシビリティ・セキュリティ・ビジネスロジック・データ整合性・新規ユーザー体験・ゴール整合性）を持ち、APIとブラウザの両方から独立して探索する。その後、トリアージエージェントが重複を除去してGitHub Issueを作成する。

**Webダッシュボード**でランの開始・進行状況のリアルタイム監視・Findingのカテゴリ別確認・LLMコスト推計が行える。

テストスクリプト不要。テストデータ不要。アプリの事前知識も不要。

---

## 仕組み

```
対象アプリ (任意のURL)
        │
        ▼  UIと公開情報からアプリとそのゴールを自律的に把握
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

**グローバルインストール:**

```bash
npm install -g @m8i-51/shoal
npx playwright install chromium
```

作業ディレクトリに `.env` を作成:

```env
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:3000
# GITHUB_TOKEN=...   # 任意: Issue作成に使用
# GITHUB_REPO=owner/repo
```

実行:

```bash
shoal          # BASE_URL に対してエージェントを実行
shoal serve    # Webダッシュボードを http://localhost:4000 で起動
```

**リポジトリをクローンして開発する場合:**

```bash
git clone https://github.com/m8i-51/shoal
cd shoal
npm install && npx playwright install chromium
cp .env.example .env   # ANTHROPIC_API_KEY と BASE_URL を設定
npm start
```

---

## Webダッシュボード

```bash
shoal serve        # グローバルインストール時
# または
npm run serve      # クローンしたリポジトリから
```

`http://localhost:4000` で起動する。以下の操作が可能:

- **ランを開始** — エージェント数・対象URL・カスタム指示を設定して実行
- **リアルタイム監視** — エージェントの探索とFinding登録をライブで確認
- **過去のラン確認** — カテゴリ別Finding・エージェント数・所要時間・コスト推計
- **アプリゴールの編集** — アプリが達成すべきゴールを定義してゴールギャップ検出を強化

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

**パターンA — 自分のプロジェクトに置く**（推奨）

```bash
# リポジトリからサンプルを取得（またはゼロから作成）
curl -O https://raw.githubusercontent.com/m8i-51/shoal/main/shoal.config.example.ts
mv shoal.config.example.ts shoal.config.ts
# shoal.config.ts を編集して実行:
shoal
```

**パターンB — shoalリポジトリ内に置く**（開発時はシンプル）

```bash
cp shoal.config.example.ts shoal.config.ts
# shoal.config.ts を編集して:
npm start
```

`shoal.config.ts` は `target` オブジェクトをエクスポートする:

```typescript
// shoal.config.ts
export const target = {
  appTools: [
    { name: "list_items", description: "アイテム一覧を取得する。", input_schema: { type: "object", properties: {}, required: [] } },
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

## アカウントマネージャー

ログインが必要なアプリには、Account Managerエージェントが認証を自律的に発見・テストする。ログインページを探し、`test-accounts/`（gitignore済み）の認証情報をテストし、セッション状態をエクスプローラーエージェントに渡すことで認証後のルートにもアクセスできる。

テスト用認証情報は `test-accounts/accounts.json` に記述:

```json
[
  { "email": "test@example.com", "password": "testpassword", "role": "user" },
  { "email": "admin@example.com", "password": "adminpassword", "role": "admin" }
]
```

---

## LLMプロバイダ

デフォルトはAnthropic Claude。別のプロバイダを使う場合は `.env` に設定する:

| プロバイダ | 変数 |
|---|---|
| Anthropic（デフォルト） | `ANTHROPIC_API_KEY` |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| OpenRouter | `LLM_PROVIDER=openrouter`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex（ChatGPTサブスク） | `npm run auth:codex` を一度実行後、`LLM_PROVIDER=codex` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

詳細は `.env.example` を参照。

---

## ライセンス

[MIT](LICENSE)
