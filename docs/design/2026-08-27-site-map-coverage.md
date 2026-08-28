# Site Map Memory（path 網羅）デザイン

日付: 2026-08-27

## 問題

既存の coverage（lens/category）と `get_path_coverage`（前回 run の visitedPaths 一覧）だけでは、**サイト全体のうちエージェントが何を見たか**が分からない。網羅率が測れず、人事エージェントも「穴」を地図ベースで埋められない。

## ゴール

- run 横断のサイト地図メモリを持つ
- path 単位で `unvisited` / `reached` / `explored` と入場回数を記録
- explored率で網羅を測る
- エージェント誘導（人事の `get_path_coverage`）とダッシュボード可視化に使う

## 決定事項

### 地図の種と成長

- `sitemap.xml`（あれば）を種にする。なければ空から開始
- 探索中に発見した同一オリジン path も地図に追加する（`discovered`）

### 訪問の深さ

- `unvisited`: 地図上にあるが未訪問
- `reached`: 到達した（入場した）
- `explored`: 同一 path で連続イテレーション ≥ 2
- `visitCount`: path に**入場した回数**のみ（同一 path 滞在では増やさない）

### 正規化（MVP）

- path のみ（query/hash 捨てる）
- 数字のみ / UUID セグメントは `:id` に畳む（動的 path 爆発防止）
- オリジン外と内蔵 denylist（`/logout`, OAuth 系, 静的アセット拡張子）を除外
- `/api/` は除外しない

### 指標

- 主指標: explored率 = explored / 既知
- 補助: 到達率 = (reached + explored) / 既知
- 地図が増えて％が下がることは仕様（世界が広がった）

### 並列と永続化

- run 内で共有 in-memory `SiteMap` を1つ
- メモリ上で更新し、`saveSiteMap` は **run 終了時に1回だけ**
- 人事は **run 先頭の地図**だけを見る（その run 中の発見は次 run 向け）

### 安全弁

- discovered 新規追加: 1 run あたり上限 500
- sitemap 種まき: path 合計上限 2000、index 子 sitemap 最大 20
- sitemap は公開 GET のみ（認証付きは対象外）。失敗は警告して続行

### `get_path_coverage` 出力

地図サマリーに含める:

1. 既知 / explored / reached / unvisited と explored率
2. 未訪問トップ N、薄い（reached のみ）トップ N
3. 直近 run で触った path（前回信号を残す）

### ダッシュボード

- `GET /api/site-map` で stats と path 一覧を返す
- Dashboard の Site Map Coverage パネルで explored 率・未訪問 path を表示

## やらないこと（後続）

- query 付き正規化
- ユーザー設定の include/exclude
- 認証付き sitemap
- ブラウザへの毎ターン強制誘導
- HTML レポートへの網羅行

## 配置

- モジュール: `framework/site-map.ts`
- 永続先: `coverage/site-map.json`（gitignore 済み `coverage/` 配下）
- 配線: `run.ts`
- API / UI: `server/index.ts`, `web/src/components/SiteMapPanel.tsx`
