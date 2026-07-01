# shoal 思想レビューと機能ロードマップ案

shoal の哲学 — **「テストする」のではなく「体験する」** — をコードベース全体から読み解き、
その思想に照らして今の機能に足りないものと、次に作るべき機能の設計案をまとめる。

---

## shoal の思想の 3 軸

| 軸 | 実装上の現れ |
|---|---|
| **体験する** | ペルソナ付きエージェントが実ユーザーとして探索。finding の文体もカテゴリ別に一人称で書かせる (`run.ts` の `post_feedback` 定義) |
| **組織の創発** | Product Discovery → Org Design → HR → 群れ。アプリごとに最適なユーザー組織を自動編成 |
| **run を重ねるほど賢くなる** | coverage の時間減衰+反復ボーナス (`framework/coverage.ts`)、page-hash diff (`framework/page-cache.ts`)、finding hotspots |

この 3 軸を基準に、以下の機能案を「どの軸を完成させるか」で整理する。

---

## 軸1: 「run を重ねるほど賢くなる」を完成させる

### 1. Experience Score — アプリの成長を測る物差し

**問題**: "help it grow" を掲げているのに、アプリが良くなったかどうかの定量トレンドがない。
`ScenarioOutcome`（achieved / reason）は既に各エージェントが `post_outcome` で記録しているが、
run 単位の HTML レポート (`framework/report.ts`) に使われるだけで、run 横断では永続化されていない。

**設計**:

- `framework/coverage.ts` の `RunCoverage` に outcome 集計を追加する:

  ```typescript
  export interface RunCoverage {
    // ...既存フィールド
    scenarioOutcomes?: {
      scenarioTitle: string;
      achieved: boolean;
      iterations: number;   // タスク完了までの手数（AgentLog.iterations から）
    }[];
  }
  ```

- 新モジュール `framework/experience-score.ts`:
  - **達成率トレンド**: 直近 N run のシナリオ達成率の推移
  - **摩擦指標**: 達成シナリオの平均イテレーション数（手数が減る = UX が改善）
  - **regression 率**: `runLog.summary.regressionFailed / regressionChecked` の推移
  - 3 指標を合成した 0–100 のスコアと、前回比の差分を返す
- ダッシュボード (`web/`) にスコアカードとスパークライン、HTML レポート冒頭に前回比を表示

**MVP**: 既存データの集計だけで成立する。エージェントの挙動には一切手を入れない。

### 2. エージェント個人記憶 — 「先週の私」を覚えている

**問題**: roster (`agents.json`) はペルソナを永続化するが、個々のエージェントが
「前回自分が何に苦労したか」を覚えていない。実ユーザーの体験の本質は継続性にある。

**設計**:

- `framework/agent-store.ts` の `Agent` に体験履歴を追加:

  ```typescript
  export interface AgentMemory {
    runId: string;
    timestamp: string;
    frustrations: string[];   // 未達成 outcome の reason、自分が出した finding タイトル
    achievements: string[];   // 達成したシナリオ
  }
  export interface Agent {
    // ...既存フィールド
    memories?: AgentMemory[];  // 直近 3 run 分だけ保持
  }
  ```

- run 終了時に、各エージェントの `AgentLog`（issuesPosted / scenarioOutcomes）から
  memory を生成して保存
- 次回 run のシステムプロンプトに注入:
  > 前回の体験: エクスポートボタンが見つからず諦めた。今回まずそこを確認し、
  > 改善されていれば finding に「修正を確認した」と書き、直っていなければ再報告せよ。
- **リテンション語り**: 「また来たユーザー」としての一人称の再訪レポートが finding になる。
  triage 側では「前回報告済み・未改善」を既存 issue へのコメント追記に振り分けられる

**副産物**: HR agent の hire/retire 判断に「このペルソナは継続的に価値ある指摘をしているか」
という材料が加わる。

### 3. Finding 採用率フィードバック — 人間の反応から学ぶ群れ

**問題**: regression agent は closed issue を再検査するが、
「どの finding がチームに採用されたか」がペルソナ設計にフィードバックされない。

**設計**:

- `framework/trackers/` の各トラッカーに close 理由の取得を追加
  （GitHub なら `state_reason`: completed = 採用 / not_planned = 不採用）
- run 開始時に前回以降の issue 状態変化を取得し、`coverage/adoption.json` に
  lens 別・ペルソナ別の採用率を蓄積
- `computeWeightedSummary()` の重み計算に採用率を混ぜる:
  採用率の高い lens はボーナス、wontfix が続く lens は減衰
- Org Designer / HR agent のプロンプトに「採用実績」を渡す →
  **刺さる指摘をするペルソナが生き残る自然選択**が完成する

**注意点**: wontfix = 無価値ではない（正しいが優先度が低いだけの場合がある）。
減衰は緩やかに、完全にゼロにはしない。

---

## 軸2: 「体験する」を深める

### 4. 環境ペルソナ — デバイス・回線・ロケールも人格の一部

**問題**: Mobile/touch レンズはプロンプト上に存在する (`framework/org-designer.ts` の
`UNIVERSAL_LENSES`) が、実際は全員が同じデスクトップ viewport で泳いでいる。
モバイル系 finding が「推測」になっている。

**設計**:

- `Agent` に環境プロファイルを追加:

  ```typescript
  export interface EnvironmentProfile {
    device?: string;        // Playwright devices のキー（"iPhone 14" 等）
    locale?: string;        // "ja-JP" 等
    colorScheme?: "dark" | "light";
    reducedMotion?: boolean;
    networkThrottle?: "slow-3g" | "fast-3g";  // CDP エミュレーション
  }
  ```

- HR agent がペルソナ生成時に環境も割り当てる（「通勤中にスマホで見る営業担当」なら
  iPhone + slow-3g、など人格と整合させる）
- ブラウザエージェント起動時の `browser.newContext()` に反映（`run.ts` の browser agent 部）
- **a11y の実証**: アクセシビリティ lens のエージェントには axe-core を注入した
  `run_a11y_audit` ツールを追加し、finding に監査結果を証拠として添付する。
  「推測の指摘」から「実測の指摘」へ

### 5. Playwright trace — エージェントが見たものをそのまま再生

**問題**: 証拠はスクリーンショットのみ。開発者が finding を再現するには
本文の手順を自分でなぞるしかない。

**設計**:

- browser context 生成時に `context.tracing.start({ screenshots: true, snapshots: true })`
- finding 保存時（`post_feedback` 実行時）に直近のアクション区間を
  `logs/traces/<runId>/<findingId>.zip` として書き出し、`Finding` に `tracePath` を追加
- HTML レポートとダッシュボードから trace viewer（`npx playwright show-trace`）への
  導線を張る。issue 本文には再現手順に加えて trace の添付方法を記載

**効果**: 「エージェントの体験を開発者が追体験する」— 思想への合致度が最も高い小粒機能。

### 6. マルチアクター・シナリオ — 群れが本当に「群れ」になる

**問題**: 各エージェントは並列に泳ぐだけで相互作用がない。実アプリのバグの宝庫は
「管理者が設定を変えた瞬間に一般ユーザーが操作中」のような同時操作にある。

**設計** (2 段階):

- **Phase A — スティグマジー（run 内の情報共有）**:
  run 中の findings を共有黒板（`collectedFindings` は既にグローバル）から読み、
  各エージェントのツールに `check_swarm_signals` を追加。
  「別のエージェントが /checkout で異常を報告した。あなたのペルソナでも再現するか確認せよ」
  という誘導を agent loop の途中に注入する。**複数ペルソナで再現した finding は
  triage で確度が上がる**
- **Phase B — ペアシナリオ**:
  `framework/scenario-designer.ts` の `Scenario` に `actors?: { role: string; goal: string }[]`
  を追加。account-manager が既に role 別アカウント（user/admin）を管理しているので、
  2 エージェントを同一シナリオに割り当て、同時に走らせる。
  「admin が権限を剥奪する ↔ user が操作を継続する」「2 人が同じレコードを同時編集する」
  といった競合系シナリオを scenario designer に生成させる

**差別化**: コラボ系・リアルタイム系アプリの同時操作テストは、他の autonomous testing
ツールがほぼ手を付けていない領域。

### 7. 時間旅行ペルソナ — 「翌日また来るユーザー」

**問題**: 全エージェントが「初回訪問」の体験しかしない。通知・ダイジェスト・
空状態→蓄積状態のライフサイクルは検査されない。

**設計**:

- エージェント個人記憶（案 2）の上に載せる: 記憶を持つエージェントは自然に
  「再訪ユーザー」になる
- scenario designer に「再訪シナリオ」タイプを追加:
  「前回作成したデータが残っているか」「未読通知はどう見えるか」
  「run をまたいで作成した下書きの続きから再開できるか」
- run 間で `storageState`（cookie / localStorage）を `cache/sessions/<agentId>.json` に
  保存・復元し、ログイン状態とアプリ内状態の継続性を実体験させる

---

## 軸3: 「help it grow」のループを閉じる

### 8. MCP サーバー化 + 修正ループ

**問題**: 今はチケットを切って終わり。「発見 → 修正 → 検証」のループが閉じていない。

**設計**:

- 新モジュール `server/mcp.ts`: `@modelcontextprotocol/sdk` で以下のツールを公開
  - `start_run(baseUrl, options)` / `get_run_status(runId)`
  - `list_findings(filter)` — Hall of Issues のデータをそのまま返す
  - `verify_fix(findingId, baseUrl)` — **既存の regression agent を単一 finding
    モードで起動**し、修正されたかを体験ベースで判定して返す
- これで Claude Code 等のコーディングエージェントから
  「shoal の top finding を修正 → プレビュー環境で `verify_fix` → PR コメント」
  という完全自律ループが組める。既存の regression 機構 (`run.ts` の
  `runRegressionAgent`) と page-hash diff がそのまま部品になる

### 9. PR ごとの Experience Diff

**問題**: 週次 run はあるが、変更単位のフィードバックがない。

**設計**:

- `.github/workflows/` に PR トリガーの example workflow を追加
- 新エントリポイント `shoal diff`:
  1. PR の変更ファイルからルート推定（Next.js 等の規約ベース + LLM 補完）+
     page-hash 差分で「変わったページ」を特定
  2. そこに小さい群れ（2–3 エージェント）を集中投下（`MAX_BROWSERS=2` 相当の軽量 run）
  3. 結果を PR コメントに要約:
     「3 人のエージェントが新しいチェックアウトを試した。2 人がステップ 3 で詰まった」
- Experience Score（案 1）があれば「この PR でスコアが +3 / −5」まで言える

### 10. shoal-bench — 検出力のベンチマーク

**問題**: shoal 自身の改善（プロンプト変更・モデル変更）が検出力に与える影響を
測る手段がない。OSS としての信頼性の担保にもなる。

**設計**:

- `bench/` に意図的にバグを仕込んだ小さなサンプルアプリ群を用意
  （a11y 違反、壊れたフォーム、サイレント保存失敗、権限チェック漏れ… 各 lens に対応）
- 各バグに正解ラベル（カテゴリ + 該当パス）を付け、run 後の findings と突合して
  検出率 / 誤検出率をスコア化する `npm run bench`
- CI で回せば、プロンプトのリファクタリングが安心してできるようになる。
  README にスコアを掲示すればプロジェクトの信頼性の証明にもなる

### 11. 破壊的操作のガードレール

**問題**: エージェントは書き込み操作を無制限に行う。staging 以外で使う際の
安全装置がなく、「本番 URL を渡したらデータを汚された」は信頼を一撃で失う事故になる。

**設計**:

- `.env` に `SHOAL_MODE=read-only | safe | full`（デフォルト `safe`）
  - `read-only`: GET 系ナビゲーションのみ。フォーム送信・クリックによる mutation を
    ブロック（browser 側は `page.route()` で POST/PUT/DELETE を遮断）
  - `safe`: 書き込みは許可するが、削除・支払い・メール送信を示唆する UI
    （LLM 判定 + キーワード）で確認を要求 or スキップして finding として記録
  - `full`: 現状の挙動
- API agent 側は `targets/types.ts` のツール定義に `destructive?: boolean` を追加し、
  モードに応じてツールリストから除外
- ダッシュボードの run 開始画面にモード選択を表示

---

## 実装順序の提案

依存関係と「小さく出して思想を証明する」観点での並び:

| 順 | 機能 | 理由 |
|---|---|---|
| 1 | Experience Score (案1) | 既存データの集計のみ。ダッシュボードの価値が一段上がる |
| 2 | ガードレール (案11) | 利用者の信頼の土台。他機能より先に欲しい安全装置 |
| 3 | エージェント個人記憶 (案2) | 小さい実装で思想的リターンが最大。案7の土台にもなる |
| 4 | Playwright trace (案5) | 独立して出せる。finding の説得力が即座に上がる |
| 5 | 採用率フィードバック (案3) | 案1の集計基盤を再利用。自然選択ループが閉じる |
| 6 | 環境ペルソナ (案4) | context 生成の変更が中心。a11y 実証は段階投入 |
| 7 | スティグマジー → ペアシナリオ (案6) | Phase A は小さく、B は大きい。分けて出す |
| 8 | MCP 化 (案8) → Experience Diff (案9) | ループを閉じる本丸。案1・regression 機構に依存 |
| 9 | 時間旅行ペルソナ (案7) | 案2の記憶基盤の上に載せる |
| 10 | shoal-bench (案10) | いつでも着手可能だが、機能が揃うほど価値が上がる |
