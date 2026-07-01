[English version here](README.md)

<p align="center">
  <img src="assets/logo-lockup.svg" alt="shoal" height="72">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@m8i-51/shoal"><img src="https://img.shields.io/npm/v/@m8i-51/shoal?color=red" alt="npm"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://playwright.dev/"><img src="https://img.shields.io/badge/Playwright-browser-45ba4b?logo=playwright&logoColor=white" alt="Playwright"></a>
  <a href="https://www.anthropic.com/"><img src="https://img.shields.io/badge/Anthropic-Claude-blueviolet?logo=anthropic&logoColor=white" alt="Anthropic"></a>
</p>

**AI が、そのアプリケーションを育てる。**

shoal は、AI エージェントが実際のユーザーとしてアプリを体験し、バグ・使いにくさ・欲しい機能を報告するフレームワーク。

エージェントはスクリプトを実行するのではなく、アプリを使う。ページを開き、操作し、迷い、気づく。そして使ってみてわかったことを伝える。繰り返すたびに探索の幅が広がり、アプリへの理解が深まっていく。

テストスクリプト不要。テストデータ不要。アプリの事前知識も不要。URL を渡すだけで動く。

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
                       ▼  重複除去してissueチケットを起票
                 トリアージ
```

各エージェントは異なるペルソナと評価観点（アクセシビリティ・セキュリティ・ビジネスロジック・UI デザイン・新規ユーザー体験など）を持ち、アプリの目的・ユーザー像・ゴールを把握した上で動く。探索のたびに「どのエリアをどれだけ見たか」が記録され、次の run では手薄な部分に自然と焦点が当たる。

---

## 何が見つかるか

各 run の終わりに以下が届く。

- **バグ** — 動作しない・エラーが出る・データがおかしい
- **UX の問題** — 分かりにくい・操作できない・迷子になる
- **機能の提案** — あったら価値が上がりそうな機能
- **ゴールとのギャップ** — アプリが目指していることに対して足りていること

GitHub Issues・Jira・Notion・Backlog・Asana など複数のトラッカーへの同時起票、または手元の HTML レポートとして確認できる。**Web ダッシュボード**でランの開始・進行状況のリアルタイム監視・Finding のカテゴリ別確認・LLM コスト推計が行える。

---

## クイックスタート

**グローバルインストール:**

```bash
npm install -g @m8i-51/shoal
npx playwright install chromium
```

テストしたいプロジェクトのディレクトリに移動して実行:

```bash
cd your-project
shoal init     # 利用可能なオプションをすべて含む .env を生成
```

`.env` を開いて最低限これを設定:

```env
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:3000   # 対象アプリの URL
```

実行:

```bash
shoal serve    # Web ダッシュボードを http://localhost:4000 で起動
shoal          # またはターミナルから直接実行
shoal config   # 既存の .env を対話形式で更新（トラッカー設定など）
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

## Web ダッシュボード

```bash
shoal serve        # グローバルインストール時
# または
npm run serve      # クローンしたリポジトリから
```

`http://localhost:4000` で起動する。以下の操作が可能:

- **ランを開始** — エージェント数・対象 URL・カスタム指示を設定して実行
- **群泳をリアルタイムで眺める** — 群泳タブでエージェントが魚として泳ぐアニメーションをライブで確認。finding を発見した瞬間にエージェントのチップが光り、タイトルが浮かぶ
- **過去のラン確認** — カテゴリ別 Finding・エージェント数・所要時間・コスト推計
- **探索日誌を生成** — run 完了後にボタン一つで、LLM がエージェントたちの探索を物語体の「探索日誌」に変換。エンジニア以外にも伝わる文体で記録される
- **Hall of Issues** — 全 run の findings を横断検索・カテゴリフィルタで一覧表示。JSON エクスポートで共有でき、コミュニティの findings URL を貼り付けてインポートすることもできる
- **アプリゴールの編集** — アプリが達成すべきゴールを定義してゴールギャップ検出を強化
- **週次ランのスケジュール設定** — ダッシュボード上で曜日・時刻を指定するだけで定期実行できる（`shoal serve` プロセスを起動し続けておく必要がある。サーバーレスで実行したい場合は後述の[定期実行](#定期実行)を参照）

---

## run を重ねるごとに賢くなる

shoal は run のたびに学習する。

**差分探索** — ブラウザエージェントがページにアクセスするたびに、ページのテキスト内容を SHA-256 でハッシュ化して記録する。次回の run では、前回と内容が変わっていないページに着いたエージェントに「unchanged — 別のエリアを探索しては」というヒントが届く。ハッシュは `cache/page-hashes/` に蓄積され、変化した部分へエージェントを自然に誘導する。

**群れの集合知** — ペルソナデザイナーは `get_finding_hotspots` ツールを使い、過去の全 run の findings を URL エリア別に集計する。問題が集中しているエリアと未探索のエリアを把握したうえで、次に送り込むエージェントの構成を決める。

**Experience Score** — アプリの体験の健康度を 0–100 のスコアとして run 横断で追跡する。シナリオ達成率（ユーザーは目的を果たせたか）・摩擦（何手かかったか）・リグレッション（直したバグが再発していないか）の 3 つのシグナルを合成し、スコアとトレンド、前回比をダッシュボードと HTML レポート冒頭に表示する。アプリが本当に良くなっているかが一目で分かる。

どの機能も設定不要。run を重ねるほど自動的に精度が上がる。

---

## 設定

| 変数 | デフォルト | 説明 |
|---|---|---|
| `TARGET` | `none` | ターゲット設定名（`example` \| `none` \| カスタム名） |
| `BASE_URL` | `http://localhost:3000` | 対象アプリの URL |
| `MAX_EXPLORERS` | `4` | API エージェントの最大数（0 で無効化） |
| `MAX_BROWSERS` | `2` | ブラウザエージェントの最大数 |
| `ANTHROPIC_API_KEY` | — | 必須 |
| `ISSUE_TRACKERS` | — | 有効にするトラッカーをカンマ区切りで指定: `github`, `jira`, `notion`, `backlog`, `asana` |
| `REFRESH_SPEC` | — | `1` を設定するとプロダクト仕様を再探索する |

**トラッカー別の設定変数**（使うものだけ設定）:

| トラッカー | 変数 |
|---|---|
| GitHub Issues | `GITHUB_TOKEN`、`GITHUB_REPO`（`owner/repo` 形式） |
| Jira | `JIRA_BASE_URL`、`JIRA_EMAIL`、`JIRA_API_TOKEN`、`JIRA_PROJECT_KEY` |
| Notion | `NOTION_API_KEY`、`NOTION_DATABASE_ID` ¹ |
| Backlog | `BACKLOG_SPACE`、`BACKLOG_API_KEY`、`BACKLOG_PROJECT_ID` |
| Asana | `ASANA_ACCESS_TOKEN`、`ASANA_PROJECT_ID` |

¹ Notion のデータベースには `Name`（title）、`Labels`（multi_select）、`Status`（select）プロパティが必要。

複数のトラッカーを同時に有効化でき、すべてのトラッカーに並列で起票される。`ISSUE_TRACKERS` が未設定でも `GITHUB_TOKEN` と `GITHUB_REPO` があれば GitHub が自動で有効になる（後方互換）。

---

## ターゲットの追加

shoal は起動時に**カレントディレクトリ**から `shoal.config.ts` を読み込む。2 通りの使い方がある:

**パターン A — 自分のプロジェクトに置く**（推奨）

```bash
# リポジトリからサンプルを取得（またはゼロから作成）
curl -O https://raw.githubusercontent.com/m8i-51/shoal/main/shoal.config.example.ts
mv shoal.config.example.ts shoal.config.ts
# shoal.config.ts を編集して実行:
shoal
```

**パターン B — shoal リポジトリ内に置く**（開発時はシンプル）

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

## 定期実行

staging 環境に週次で shoal を当てるには、GitHub Actions workflow をリポジトリに追加する。

`shoal init` を実行すると `.github/workflows/shoal-weekly.yml` を自動生成するか聞かれる。またはこのリポジトリの例をコピーする方法もある:

```bash
curl -O https://raw.githubusercontent.com/m8i-51/shoal/main/.github/workflows/shoal-weekly.example.yml
mv shoal-weekly.example.yml .github/workflows/shoal-weekly.yml
```

その後、リポジトリの **Actions secrets** (`Settings → Secrets and variables → Actions`) に `ANTHROPIC_API_KEY` を追加する。

workflow は毎週月曜 09:00 UTC に自動実行され、Actions タブから手動実行もできる。発見した問題は組み込みの `GITHUB_TOKEN` を使って GitHub Issues として起票される。

---

## アカウントマネージャー

ログインが必要なアプリには、Account Manager エージェントが認証を自律的に発見・テストする。ログインページを探し、`test-accounts/`（gitignore 済み）の認証情報をテストし、セッション状態をエクスプローラーエージェントに渡すことで認証後のルートにもアクセスできる。

テスト用認証情報は `test-accounts/accounts.json` に記述:

```json
[
  { "email": "test@example.com", "password": "testpassword", "role": "user" },
  { "email": "admin@example.com", "password": "adminpassword", "role": "admin" }
]
```

---

## LLM プロバイダ

デフォルトは Anthropic Claude。別のプロバイダを使う場合は `.env` に設定する:

| プロバイダ | 変数 |
|---|---|
| Anthropic（デフォルト） | `ANTHROPIC_API_KEY` |
| Amazon Bedrock | `LLM_PROVIDER=bedrock`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| OpenRouter | `LLM_PROVIDER=openrouter`, `LLM_API_KEY`, `LLM_MODEL` |
| Groq | `LLM_PROVIDER=groq`, `LLM_API_KEY`, `LLM_MODEL` |
| Gemini | `LLM_PROVIDER=gemini`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex（ChatGPT サブスク） | `npm run auth:codex` を一度実行後、`LLM_PROVIDER=codex` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

Bedrock を使う場合は `LLM_MODEL` に Bedrock のモデル ID（例: `anthropic.claude-3-5-sonnet-20241022-v2:0`）を設定する。クロスリージョン推論プロファイル（例: `us.anthropic.claude-3-5-sonnet-20241022-v2:0`）にも対応している。

詳細は `.env.example` を参照。

---

## ライセンス

[MIT](LICENSE)
