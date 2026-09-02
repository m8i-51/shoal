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
        ├──────────────────────────────────┬──────────────────┐
        ▼                                  ▼                  ▼
  APIエージェント ×N               ブラウザエージェント ×N   閾値エージェント ×M
  APIで探索                        実際のUIをブラウズ         境界・上限を踏む
        │                                  │                  │
        └──────────────────┬───────────────┴──────────────────┘
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

テストしたいプロジェクトの、shoal 設定を置くディレクトリに移動して実行:

```bash
cd your-project          # サブディレクトリでも可 — [設定の場所](#設定の場所) を参照
shoal init               # 利用可能なオプションをすべて含む .env を生成
```

`.env` を開いて最低限これを設定:

```env
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:3000   # 対象アプリの URL
```

**同じディレクトリから**実行:

```bash
shoal serve    # Web ダッシュボードを http://localhost:4000 で起動
shoal          # またはターミナルから直接実行
shoal config   # 既存の .env を対話形式で更新（トラッカー設定など）
```

起動時に、どの `.env` を読んだか（または読めなかったか）がログに出ます。`0 variables injected` と出たら、`.env` のあるディレクトリにいません。

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
- **Hall of Issues** — 全 run の findings を横断検索・カテゴリフィルタで一覧表示。JSON エクスポートで共有でき、GitHub raw / gist の findings URL を貼り付けてインポートすることもできる
- **アプリゴールの編集** — アプリが達成すべきゴールを定義してゴールギャップ検出を強化
- **週次ランのスケジュール設定** — ダッシュボード上で曜日・時刻を指定するだけで定期実行できる（`shoal serve` プロセスを起動し続けておく必要がある。サーバーレスで実行したい場合は後述の[定期実行](#定期実行)を参照）

### ダッシュボードへのアクセス

ダッシュボードは「閲覧用の画面」ではなく、任意の URL に対してランを起動できる操作面である。そのため既定で保護されている:

- **`127.0.0.1`** に bind する（このマシンからのみ到達可能）。トークンは不要。
- コンテナや開発サーバーなどで外部公開する場合は `SHOAL_HOST=0.0.0.0` を設定する。このときトークンが**必須**になる。`SHOAL_TOKEN` を設定するか、未設定なら起動時に自動生成され `?token=…` 付き URL が表示される。

```
shoal dashboard → http://0.0.0.0:4000
[auth] bound to 0.0.0.0, which is reachable from other machines — a token is required.
[auth] generated token: 6f1c…
[auth] open: http://0.0.0.0:4000/?token=6f1c…
```

ポートを開けるより SSH トンネル（`ssh -L 4000:localhost:4000 host`）のほうが安全なことが多い。詳細は [SECURITY.md](SECURITY.md) を参照。

---

## run を重ねるごとに賢くなる

shoal は run のたびに学習する。

**差分探索** — ブラウザエージェントがページにアクセスするたびに、ページのテキスト内容を SHA-256 でハッシュ化して記録する。次回の run では、前回と内容が変わっていないページに着いたエージェントに「unchanged — 別のエリアを探索しては」というヒントが届く。ハッシュは `cache/page-hashes/` に蓄積され、変化した部分へエージェントを自然に誘導する。

**群れの集合知** — ペルソナデザイナーは `get_finding_hotspots` ツールを使い、過去の全 run の findings を URL エリア別に集計する。問題が集中しているエリアと未探索のエリアを把握したうえで、次に送り込むエージェントの構成を決める。

**エージェントの個人記憶** — 各ペルソナは直近数 run 分の自分の体験（何に苦労したか・何を報告したか・何を達成したか）を覚えている。次の run では「再訪ユーザー」として戻ってきて、まず前回苦労した箇所を確認し（改善されていれば improvement として報告、直っていなければ「前回から変わっていない」と再報告）、それから新しいエリアの探索に移る。findings に実ユーザーの継続的な関係性が生まれる。

**再訪ユーザーセッション** — 各ブラウザエージェントの storage state（cookie / localStorage）はペルソナごとに `cache/sessions/` に保存され、次の run で復元される。エージェントは同じユーザーとして同じセッションでアプリに戻ってくる — ログインしたまま、前回作ったデータとともに。シナリオ設計にも run ごとに 1 つ再訪ユーザーの旅程（下書きの再開、蓄積したデータの確認）が含まれるため、空→蓄積・通知・セッション失効といったライフサイクル状態が実ユーザーの遭遇の仕方でテストされる。

**マルチアクターシナリオ** — 本物の並行性バグは、2 人のユーザーが同じデータを同時に触る場所に潜んでいる。アカウントマネージャーが 2 つ以上の role を発見すると、シナリオデザイナーは run ごとに 1 つ、2 アクターのシナリオを生成する — 管理者がユーザーの操作中に権限を剥奪する、2 人が同じレコードを同時編集する、など。2 体のブラウザエージェントが*同時に*演じる。割り当ては枠順ではなく、ペルソナの role とテストアカウント / actor の role を突き合わせ、一致するセッションを注入する。更新されないままの古いデータ・黙って上書きされる編集・セッション途中で効かない権限変更を監視する。

**群れのシグナル** — 同じ run のエージェントは黒板を共有する。`check_swarm_signals` ツールで他のエージェントが直前に報告した発見を確認でき、自分のいるエリアに関係するシグナルがあれば自分のペルソナで再現を試みる。複数の異なるペルソナで再現された発見は、triage でマージされて確度の高い issue になる。

**環境ペルソナ** — 環境はペルソナの人格の一部。ペルソナデザイナーは採用するエージェントに実際のブラウジング環境 — スマホ（Playwright のデバイスエミュレーションによる実際のタッチ操作とモバイル viewport）、ロケール、ダークモード、reduced motion、遅い 3G 回線 — をその人の生活に合わせて割り当てられる。モバイルやアクセシビリティの finding が「推測」ではなく、その環境でアプリを実際に体験した結果になる。さらにブラウザエージェントは `run_a11y_audit` ツール（axe-core）を持ち、現在のページの WCAG 違反を実測できる — アクセシビリティ finding が具体的なルールと要素を証拠として引用するようになる。

**採用フィードバック** — triage が issue を起票するとき、どの観点（lens / シナリオ）から生まれた指摘かを記録しておく。以降の run でチームがその issue をどう close したかを確認し（修正済み = *採用*、not planned = *不採用*）、採用率をペルソナ採用とシナリオ設計に還元する。チームが実際に動く指摘を出す観点は多く採用され、不採用が続く観点は減っていく（ただし完全には消えない — 不採用は優先度が低いだけの場合もあるため）。

**Experience Score** — アプリの体験の健康度を 0–100 のスコアとして run 横断で追跡する。シナリオ達成率（ユーザーは目的を果たせたか）・摩擦（何手かかったか）・リグレッション（直したバグが再発していないか）の 3 つのシグナルを合成し、スコアとトレンド、前回比をダッシュボードと HTML レポート冒頭に表示する。アプリが本当に良くなっているかが一目で分かる。

どの機能も設定不要。run を重ねるほど自動的に精度が上がる。

---

## 設定の場所

shoal は `.env`・`test-accounts/`・`shoal.config.ts` の読み込みと `logs/`・`findings/` の書き込みを、**カレントディレクトリ**（`cd` した場所）基準で行います。グローバルインストール先や、モノレポのルートを自動では探しません。

起動時のログ:

```
[env] working directory: /path/you/ran/from
[env] loaded /path/you/ran/from/.env (12 variables)
```

`.env` が無い場合:

```
[env] no .env found at /path/you/ran/from/.env (0 variables injected)
```

注入件数が 0 だと、想定していないデフォルトプロバイダ（Anthropic）に落ち、認証情報なしで失敗します。ログもカレントディレクトリ側に出るので、サブディレクトリの設定を見ていないことに気づきにくいです。

**サブディレクトリに設定だけ置く**（モノレポでよくある運用）:

```bash
mkdir -p apps/shoal
cd apps/shoal
shoal init                 # apps/shoal/.env を生成
# test-accounts/accounts.json もここに置く
shoal serve                # ダッシュボード。logs / findings も apps/shoal/ に出る
```

リポジトリルートから起動する場合はパスを指定します:

```bash
shoal serve --dir apps/shoal
shoal --dir apps/shoal
# .env だけ別パスで読み、ログはカレントディレクトリに残す:
shoal serve --env-file apps/shoal/.env
```

`--dir` は `test-accounts/`・`logs/`・`findings/`・`shoal.config.ts` の解決先も切り替えます。環境変数は `SHOAL_DIR` / `SHOAL_ENV_FILE` です。

## 設定

| 変数 | デフォルト | 説明 |
|---|---|---|
| `TARGET` | `none` | ターゲット設定名（`example` \| `none` \| カスタム名） |
| `BASE_URL` | `http://localhost:3000` | 対象アプリの URL |
| `MAX_EXPLORERS` | `4` | API エージェントの最大数（0 で無効化） |
| `MAX_BROWSERS` | `2` | ブラウザエージェントの最大数 |
| `MAX_THRESHOLDS` | `1` | 閾値エージェントの最大数（0 で無効化）。Product Discovery が推論した入力上限・プラン制限・体験劣化点などをブラウザ主で探査する。古いキャッシュ仕様に `thresholdCandidates` が無い場合は `REFRESH_SPEC=1` で再探索すること |
| `ANTHROPIC_API_KEY` | — | 必須 |
| `ISSUE_TRACKERS` | — | 有効にするトラッカーをカンマ区切りで指定: `github`, `jira`, `notion`, `backlog`, `asana` |
| `SHOAL_MODE` | `safe` | セーフティモード: `read-only` \| `safe` \| `full`（下記参照） |
| `SHOAL_TRACE` | `1` | ブラウザエージェントのセッションを Playwright trace として記録（`0` で無効化）。finding 保存時に区間 trace（`logs/traces/<run>/<findingId>.zip`）を切り出し、セッション全体は `logs/traces/<run>/<agentId>.zip` |
| `REFRESH_SPEC` | — | `1` を設定するとプロダクト仕様を再探索する |
| `SHOAL_MAX_USD` | — | 1 run のコスト上限（推定 USD）。到達時点で以降の LLM 呼び出しを止め、残りのレーンをスキップする（それまでの findings は保存・レポートされる） |
| `SHOAL_HOST` | `127.0.0.1` | ダッシュボードの bind アドレス。既定はループバックのみ。外部公開する場合に設定する（[ダッシュボードへのアクセス](#ダッシュボードへのアクセス)参照） |
| `SHOAL_TOKEN` | — | ダッシュボードのトークン。`SHOAL_HOST` がループバック以外のときは必須。未設定なら起動時に自動生成して表示する |
| `SHOAL_BROWSER_ITERATIONS` | `12` | ブラウザエージェントのターン数上限 |
| `SHOAL_THRESHOLD_ITERATIONS` | `12` | しきい値エージェントのターン数上限 |
| `SHOAL_EXPLORER_CONCURRENCY` | `2` | API エージェントの並列実行数 |
| `SHOAL_VIEWPORT` | `1024x640` | エージェントのブラウザ viewport（ペルソナのデバイス指定が優先される） |

**セーフティモード** — エージェントは探索中にデータを書き込むため、どこまで許可するかを選べる:

- `read-only` — 一切書き込まない。ブラウザエージェントの mutation リクエスト（POST/PUT/PATCH/DELETE）をネットワーク層でブロックする。本番環境に向けても安全。
- `safe`（デフォルト） — テストデータの作成・編集は許可するが、レコード削除・支払い・メールや招待の送信など不可逆な操作の直前で止まるようエージェントに指示する。
- `full` — 制限なし。使い捨て環境でのみ使用すること。

`safe` と `read-only` では、ターゲット設定で `destructive: true` を付けた API ツールがエージェントのツールセットから除外される。モードはダッシュボードの実行開始ダイアログでも run ごとに選択できる。

**コスト上限** — `SHOAL_MAX_USD` を設定すると、推定コストが上限に達した時点で run を止める。ターン数上限が「各エージェントがどれだけ探索するか」を縛るのに対し、こちらは「run 全体でいくらまで使うか」を縛る。

**対象アプリの内容は信頼できない入力** — エージェントはアプリを読み、読んだ内容にもとづいて行動する。つまりアプリが表示できるテキストはすべてモデルに届く。shoal はアプリ由来の内容をフェンスで囲み、「フェンス内はデータであって指示ではない」とエージェントに明示する。ただしこれは緩和策であって保証ではない。自分が管理していないコンテンツを含むアプリに、ログイン済みの群れを向けてはいけない。詳細は [SECURITY.md](SECURITY.md#prompt-injection-from-the-target-app) を参照。

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

Backlog の課題タイプ ID / 優先度 ID はプロジェクトごとに違います。起票時にプロジェクトの課題タイプと優先度の一覧を取得し、指摘カテゴリ（`bug` / `ux` / `feature-request` / `goal-gap`）を名前（バグ・要望・タスク、高・中・低など）で対応付けます。名前で判断できないときだけモデルに選ばせます。選んだタイプと優先度はログに出ます（`[backlog] selected issueType "バグ" (id=…) for category=bug`）。

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

`shoal.config.ts` は `target` オブジェクトをエクスポートする。API エクスプローラーを使う場合は `appTools` と `execute` を含める:

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

`appTools` と `execute` は API エクスプローラー用であり、ログインには不要。`test-accounts/accounts.json` だけで足り、設定ファイルに `credentials` や `projectPath` だけがあってもそれらは適用される。

---

## MCP サーバー — 修正ループを閉じる

shoal は [MCP](https://modelcontextprotocol.io/) サーバーとして動作でき、Claude Code などのコーディングエージェントが **発見 → 修正 → 検証** のループを丸ごと回せる:

```bash
shoal mcp   # stdio transport
```

エージェント側の MCP 設定（例: `.mcp.json`）に登録する:

```json
{ "mcpServers": { "shoal": { "command": "shoal", "args": ["mcp"] } } }
```

公開ツール:

| ツール | 役割 |
|---|---|
| `start_run` | 探索 run を開始（URL・エージェント数・セーフティモード） |
| `get_run_status` | 進行状況の確認: findings 件数、regression 結果、ログ末尾 |
| `list_findings` | run 横断で findings を取得（run / カテゴリ / テキストで絞り込み） |
| `verify_fix` | 検証専用エージェント 1 体が該当 finding のフローをなぞり直し、`fixed` / `still_broken` / `inconclusive` を返す |
| `get_experience_score` | Experience Score のトレンド — 修正で体験は本当に良くなったか |

コーディングエージェントは `list_findings` で finding を選んで修正し、再デプロイして `verify_fix` を呼べば、報告されたフローそのままをエージェントがなぞって検証する — 人間を挟まずに「発見 → 修正 → 検証」のループが閉じる。

---

## PR Experience Diff

テストが通るかではなく「この変更がユーザーにどう*感じられる*か」を PR ごとにフィードバックする:

```bash
shoal diff                    # origin/main との diff
shoal diff --base origin/dev  # 任意の ref との diff
```

`shoal diff` は PR の変更ファイルをルートにマッピングし（Next.js の pages / app router、`views/`・`routes/` 規約に対応）、プレビュー環境のそのエリアへ小さい群れ（デフォルト: ブラウザ 2 体）を集中投下して、findings と Experience Score の変化を PR コメントとして投稿する:

> **Experience Score: 72/100** (▲5 vs previous run)
> Agents focused on the areas this PR touches: `/checkout`
> 🐛 **[bug] Checkout button unresponsive** — Nadia
> I tapped the checkout button and nothing happened.

`GITHUB_TOKEN` がない場合は `logs/diff_<runId>.md` に保存される。CI 用の example は `.github/workflows/shoal-diff.example.yml` — PR ごとに `PREVIEW_URL` に対して実行する。

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

## shoal-bench

群れは実際どれくらい問題を検出できるのか？ `bench/` には**2 種類のサンプルアプリ**と正解ラベルが同梱されている:

| バリアント | アプリ | 仕込みバグ数 | ラベル |
|---|---|---:|---|
| `store`（デフォルト） | カート / 管理 / ナビ付きストア | 7 | `bench/labels.json` |
| `forms` | サポート問い合わせフォーム | 3 | `bench/labels-forms.json` |

各ラベルには `lens` / `path` / `category` メタデータがあり、領域別の採点ができる。

```bash
npm run bench                         # store バリアント
npm run bench:forms                   # forms バリアント
SHOAL_BENCH_MIN=60 npm run bench      # 検出率 60% 未満で非ゼロ終了（CI の回帰ゲート）
BENCH_RECORD=1 npm run bench          # モデル別スコアを bench/scores.json に追記
```

スコアラーが findings をラベルと突合し、検出レポートを出力する:

```
Detection rate: 5/7 (71%)
  ✓ cart-total-wrong
      └ "Cart total doesn't match item quantities"
  ✗ low-contrast (accessibility @ /) — The Buy button text is nearly the same color as its background
```

### 公開済み検出スコア

`BENCH_RECORD=1` で記録したスコア（`bench/scores.json`）:

| バリアント | モデル | 検出率 | Findings | 日付 | 設定 |
|---|---|---:|---:|---|---|
| store | claude-sonnet-4-20250514 | 71% | 11 | 2026-08-15 | MAX_BROWSERS=3, default prompts |

> **1 設定・1 回分のサンプルである。** ベンチマークとしてではなく、単一のサンプルとして読むこと。エージェントの探索は非決定的なので検出率は run ごとにぶれるし、`forms` バリアント・他モデル・他のエージェント数での挙動についてはこの表は何も語っていない。行が増えるまでは「この設定に対する回帰ベースライン」として扱うのが正しい。

**スコアの追加** — 手元のプロバイダでベンチを回し、`bench/scores.json` のエントリと表の行を追加した PR を歓迎する:

```bash
BENCH_RECORD=1 npm run bench          # store バリアント
BENCH_RECORD=1 npm run bench:forms    # forms バリアント
```

実行には実際の LLM 課金が発生するので上限を付けること: `SHOAL_MAX_USD=2 BENCH_RECORD=1 npm run bench`。
`config` フィールドにモデルとエージェント数を必ず書く（設定の分からないスコアは何とも比較できない）。

プロンプト・モデル・探索ロジックを変更したときの回帰テストとして使える。仕込みバグは直さないこと（アプリのテストスイートがバグの存在を固定している）。

---

## アカウントマネージャー

ログインが必要なアプリには、Account Manager エージェントが認証情報をテストし、セッション状態をエクスプローラーエージェントに渡すことで認証後のルートにもアクセスできる。

`test-accounts/accounts.json`（gitignore 済み）にテスト用認証情報を置く。このファイルだけで足りる。`shoal.config.ts` の `target.credentials` は任意:

```json
[
  { "email": "test@example.com", "password": "testpassword", "role": "user" },
  { "email": "admin@example.com", "password": "adminpassword", "role": "admin" }
]
```

起動時にこのファイルを読み、Account Manager が各アカウントでログインする。ログイン先はプロダクトディスカバリが見つけたログイン URL（トップの `BASE_URL` だけではない）。Playwright のセッションを保存し、ブラウザエージェントに渡す。シード用の管理者アカウントがある場合（`accounts.json` または `target.credentials`）は、ユーザー管理を探索してロールごとにテストアカウント作成も試みる。

セッション注入に失敗した場合、ブラウザエージェントに架空の ID/PW を推測させない。`accounts.json` の値と発見済みのログイン URL を渡して入力させるか、未ログインのまま探索する場合は資格情報を推測するなと明示する。

起動ログには、`accounts.json` を読んだか、設定の credentials があるか、Account Manager を動かした／スキップした理由が必ず出る。

`shoal.config.ts` の `appTools` と `execute` は API エクスプローラー用であり、ログインには不要。ツール定義がなくても `credentials` や `projectPath` は適用される。

---

## LLM プロバイダ

デフォルトは Anthropic Claude。別のプロバイダを使う場合は `.env` に設定する:

| プロバイダ | 変数 |
|---|---|
| Anthropic（デフォルト） | `ANTHROPIC_API_KEY` |
| Amazon Bedrock | `LLM_PROVIDER=bedrock`, `AWS_REGION`（キーは省略可。デフォルトの認証チェーンを使用） |
| OpenAI | `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL` |
| OpenRouter | `LLM_PROVIDER=openrouter`, `LLM_API_KEY`, `LLM_MODEL` |
| Groq | `LLM_PROVIDER=groq`, `LLM_API_KEY`, `LLM_MODEL` |
| Gemini | `LLM_PROVIDER=gemini`, `LLM_API_KEY`, `LLM_MODEL` |
| Codex（ChatGPT サブスク） | `npm run auth:codex` を一度実行後、`LLM_PROVIDER=codex` |
| Claude CLI（Claude Code サブスク） | `npm run auth:claude` を一度実行後、`LLM_PROVIDER=claude-cli` |
| Ollama | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_MODEL` |

### Claude CLI（Claude Code サブスク）

Anthropic の Free / Pro / Max サブスクを、**公式 Claude Code のログイン**経由で使う方式です（xangi / OpenClaw と同型）。shoal は OAuth トークンを読みません・保存しません。

**前提**

- [Claude Code](https://code.claude.com/docs/en/overview) がインストールされ、`claude` が PATH にあること
- Claude Pro / Max（または Team / Enterprise）などのサブスク

**セットアップ**

```bash
npm run auth:claude
# または:
#   claude auth login
#   # .env に LLM_PROVIDER=claude-cli と LLM_MODEL=claude-sonnet-4-6 を設定
```

`auth:claude` はログイン確認後、`.env` に `LLM_PROVIDER=claude-cli` を書き込みます。

**起動**

いつもどおりです。

```bash
shoal
# または
npm start
shoal serve
```

**API キーとの関係**

- サブスク枠で使いたい場合: `.env` とシェルから `ANTHROPIC_API_KEY` を外す（キーがあると Claude Code が API 従量課金側を優先することがある）
- API キーだけで使う場合（従来どおり）: `ANTHROPIC_API_KEY` を設定し、`LLM_PROVIDER` は未設定または `anthropic`

**規約について**

Anthropic は、サードパーティが Claude.ai ログインや Free/Pro/Max 認証情報を自前 API クライアントで仲介することを禁止しています。`claude-cli` はユーザー自身が公式 Claude Code にログインした状態で、Agent SDK / Claude Code を起動するだけです。shoal をホスト／再配布する用途では、API キーまたは Bedrock を推奨します。

**トラブルシュート**

- `claude` not found → Claude Code を入れ、新しいシェルで PATH を確認
- `auth status` 失敗 → `claude auth login` を再実行
- 権限プロンプトが出る → shoal は Claude Code 組み込みツールを無効化し、shoal のツールだけを許可する想定。最新の Claude Code に更新して再試行

### Amazon Bedrock

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` は **未設定のまま**にすると、デフォルトの AWS 認証チェーン（`~/.aws/credentials`、名前付きプロファイル、SSO キャッシュ、インスタンスロール）が使われます。マシンのデフォルトプロファイルに長期キーがある場合、短命な `aws sso login` は拒否されることが多いです。そのときは新しいログインを無理に使わず、既存キー（または専用プロファイル）を使ってください。

`.env` に空の `AWS_ACCESS_KEY_ID=` / `AWS_SECRET_ACCESS_KEY=` を書かないでください。空文字が入ると認証チェーンが壊れます。shoal は起動時に空の AWS キーを無視し、警告を出します。

`LLM_MODEL` には基盤モデル ID か推論プロファイル ID を指定します。作業リージョンでは、リージョン内呼び出しや地域限定プロファイルに未対応の世代があります。データ所在を国内に閉じたい場合は、その地域プロファイルが存在する世代を選んで組み合わせてください:

| スコープ | `LLM_MODEL` の例 | 典型的な `AWS_REGION` |
|---|---|---|
| 基盤モデル（オンデマンド、リージョンが提供している場合） | `anthropic.claude-3-5-haiku-20241022-v1:0` | モデルがあるリージョン |
| US クロスリージョン | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | `us-east-1` |
| EU クロスリージョン | `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` | `eu-central-1` |
| APAC クロスリージョン | `apac.anthropic.claude-sonnet-4-5-20250929-v1:0` | `ap-northeast-1` |
| 日本（東京 + 大阪のみ） | `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` | `ap-northeast-1` |
| 日本 | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | `ap-northeast-1` |
| 日本 | `jp.anthropic.claude-sonnet-4-6` | `ap-northeast-1` |

アカウントで使えるプロファイルは `aws bedrock list-inference-profiles` で確認できます。コピー用の例は `.env.example` にあります。

---

## ライセンス

[MIT](LICENSE)
