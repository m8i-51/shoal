# shoal-bench 拡充設計

## 概要

shoal-bench の残タスク（バグバリエーション拡充・検出力の可視化・CI 回帰ゲート）を一括で実装する。
既存の単一ストアアプリ（`bench/app.ts`）を拡張し、main マージ時に LLM ベンチを走らせて回帰を検知する。
スコアはリポジトリにコミットせず、GitHub Actions Job Summary にのみ掲示する。

## 背景と目標

| 目標 | 内容 |
|------|------|
| A. 網羅性 | 主要 evaluation lens をバランスよくカバーする仕込みバグを追加 |
| B. 可視化 | ベンチ結果を OSS 利用者が確認できる形で公開する |
| C. 回帰ゲート | プロンプト・モデル変更で検出力が落ちたとき CI を失敗させる |

### 採用した方針

- **アプローチ**: 単一アプリ拡張（第 2 アプリは作らない）
- **CI タイミング**: `push` to `main` のみ（PR では走らない）
- **スコアの置き場所**: GitHub Actions Job Summary のみ（`scores.json` のコミット・README 自動テーブルは行わない）

## バグ拡充

### 現状（7 バグ）

| ID | lens |
|----|------|
| `admin-unprotected` | security |
| `cart-total-wrong` | business-logic |
| `silent-save-failure` | data-integrity |
| `missing-alt-text` | accessibility |
| `low-contrast` | accessibility |
| `delete-no-confirm` | ux-design |
| `broken-help-link` | ux-design |

### 追加（5 バグ → 合計 12）

| ID | lens | 内容 |
|----|------|------|
| `negative-price-accepted` | business-logic | マイナス価格の商品を追加できてしまう |
| `xss-search-reflected` | security | `/search?q=` の入力がエスケープされず HTML に反映される |
| `empty-cart-no-guidance` | new-user | カートが空のとき次に何をすればよいかの案内がない |
| `no-success-feedback` | ux-design | 商品追加後に成功メッセージが出ず、保存されたか分からない |
| `checkout-disabled-no-explanation` | product-pm | カートが空のとき Checkout が無効だが理由が表示されない |

### 実装ルール

- 各バグは `bench/labels.json` と 1:1 対応する
- `bench/__tests__/app.test.ts` で「仕込みバグが存在し続ける」ことを固定する（誤修正の防止）
- `low-contrast` についても固定テストを追加する（現状テスト欠落）
- HTML/CSS コメントやソース内にバグの答えを書かない（エージェントがソースから読めないようにする）

## スコアリング拡張

### `labels.json` スキーマ

既存フィールドに `lens` を追加する。

```json
{
  "id": "admin-unprotected",
  "lens": "security",
  "description": "...",
  "keywords": ["admin", "auth", ...]
}
```

### `BenchResult` 拡張

`scoreFindings()` の戻り値に lens 別集計を追加する。

```typescript
interface BenchResult {
  // 既存フィールド
  byLens: Record<string, { detected: number; total: number }>;
}
```

### 採点ロジック

- 既存のキーワード突合（`title` + `body`、大文字小文字無視）は変更しない
- 検出率 = `detected.length / labels.length`（0..1）

## CI ワークフロー

### 新規 `.github/workflows/bench.yml`

```yaml
name: Bench

on:
  push:
    branches: [main]

jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npx playwright install chromium
      - run: npm run bench
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SHOAL_BENCH_MIN: "55"
          MAX_BROWSERS: "2"
      - name: Write job summary
        if: always()
        run: node bench/write-summary.mjs
```

### 環境変数

| 変数 | 値 | 用途 |
|------|-----|------|
| `ANTHROPIC_API_KEY` | GitHub Secret | LLM 呼び出し（必須） |
| `SHOAL_BENCH_MIN` | `55` | 12 個中 7 個未満（58% 未満）で exit 1 |
| `MAX_BROWSERS` | `2` | コスト・時間の抑制 |

### PR との関係

- 既存 `ci.yml`（tsc + vitest + build:web）は PR でも main でも従来通り実行
- bench は main マージ後のみ。PR では LLM コストをかけない

## 結果の可視化（GitHub Actions Summary）

### 方針

リポジトリに生成物をコミットしない。理由:

- bot commit による履歴の汚染を避ける
- フォーク・clone にメンテナ向け生成物が混ざらない
- スコアの出所（いつ・どの commit で走ったか）が Actions 上で明確

### `bench/write-summary.mjs`

bench 終了後、直近の `logs/bench_*.json` を読み、`$GITHUB_STEP_SUMMARY` に Markdown を書き込む。

**Summary に含める内容:**

- 全体検出率（例: 9/12 = 75%）
- lens 別の検出状況テーブル
- 検出できたバグ一覧（✓）と見逃し（✗）
- run ID・commit SHA・実行日時

### README の更新

`README.md` / `README_JA.md` の shoal-bench セクションに以下を追記する（数値テーブルは置かない）:

- バグ数を 7 → 12 に更新
- main マージ後に [Bench workflow](.github/workflows/bench.yml) が走る旨
- 最新結果は GitHub Actions の Job Summary を参照する旨
- ローカル実行: `npm run bench` / `SHOAL_BENCH_MIN=55 npm run bench`

## スクリプト

| コマンド | 用途 |
|---------|------|
| `npm run bench` | 1 モデルで bench 実行＋採点（既存） |
| `npm run bench:matrix` | 複数モデルを順次実行（メンテナ手動用、任意） |

`bench:matrix` は `bench/matrix.json` にモデル定義を置き、各実行後に Summary 相当の出力をコンソールに出す。CI には組み込まない。

## テスト

| 対象 | 内容 |
|------|------|
| `bench/__tests__/app.test.ts` | 新 5 バグ + `low-contrast` の固定テスト |
| `bench/__tests__/score.test.ts` | lens 別集計、既存キーワード突合 |
| `bench/__tests__/write-summary.test.ts` | Summary Markdown 生成（`GITHUB_STEP_SUMMARY` を temp ファイルで代替） |

CI の vitest には LLM を使わない。スコアリング・Summary 生成はユニットテストでカバーする。

## エラー処理

| 状況 | 挙動 |
|------|------|
| 検出率 < `SHOAL_BENCH_MIN` | exit 1 → CI 失敗（既存 `bench/index.ts` の挙動） |
| `ANTHROPIC_API_KEY` 未設定 | 明確なエラーメッセージで即終了 |
| bench 実行中の LLM/Playwright エラー | 非ゼロ終了。Summary は `if: always()` で可能な範囲出力 |
| `logs/bench_*.json` が見つからない | Summary ステップはエラー内容を記載して終了 |

## スコープ外

- 第 2 サンプルアプリの追加
- `scores.json` のリポジトリコミット
- README への数値テーブル・shields.io バッジ
- PR トリガーでの bench 実行
- Release Notes への自動掲載（将来検討可）

## 実装ファイル一覧（予定）

| ファイル | 変更 |
|---------|------|
| `bench/app.ts` | 5 バグ追加、`/search` ルート等 |
| `bench/labels.json` | 5 ラベル追加、全ラベルに `lens` |
| `bench/score.ts` | `byLens` 集計、`formatBenchResult` 拡張 |
| `bench/index.ts` | lens 別出力、Summary 用メタデータ |
| `bench/write-summary.mjs` | Job Summary 生成 |
| `bench/matrix.json` | 手動マトリクス用モデル定義（任意） |
| `.github/workflows/bench.yml` | 新規 |
| `README.md` / `README_JA.md` | バグ数・Actions リンク更新 |
| `package.json` | `bench:matrix` スクリプト追加 |
