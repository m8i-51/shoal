# Threshold Agent Lane — Design Spec

**Date:** 2026-08-27  
**Status:** Approved for implementation

## Problem

shoal の API エージェントは裏側の境界を突きやすく、ブラウザエージェントは一般的な体験探索に強い。一方、入力上限・プラン制限・権限の切れ目・体験劣化点といった「閾値」は、偶然頼りになりやすく体系的に踏まれにくい。

## Goal (MVP)

Product Discovery が推論した閾値候補を、専用の第3レーン（threshold エージェント）がブラウザ主・API 補助で探査し、境界付近のバグ／曖昧な失敗を finding として報告する。

成功条件:

- 他レーンを壊さない
- 境界付近の不具合を finding 化できる道がある
- 後から期待値判定・健全度指標を載せられるデータ形である

## Non-goals (MVP)

- `expectedBehavior` に基づく期待値突合
- 閾値健全度スコア / Experience Score 連携
- Hall での候補人手編集
- HR / Org Design による閾値ペルソナ採用
- ephemeral agent の memory / 再訪セッション
- explorers と browsers の実行順の大規模並列化再設計
- `run.ts` からの browser 実行ループ大規模リファクタ

## Architecture

```
Product Discovery
        │
        ▼  thresholdCandidates[]
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
  API ×N         Browser ×N    Threshold ×M
  (既存)          (既存)        (新規)
        │              │              │
        └──────────────┴──────┬───────┘
                              ▼
                    collectedFindings → Triage
```

- **種別:** `agentType: "threshold"`
- **配置:** Discovery 後に候補マップを作り、browser エージェントと同一波で並列起動
- **数:** `MAX_THRESHOLDS`（デフォルト `1`、`0` で無効）
- **操作:** ブラウザツール一式 +（API ツールがあるとき）仕込み用 API
- **報告:** 既存 `post_feedback`。bug＝技術口調、ux＝体験口調
- **ガード:** 既存 `SHOAL_MODE`
- **エージェント実体:** HR 不要の ephemeral `Threshold Prober`（roster 変更なし）

## Data model

`ThresholdCandidate` は `framework/threshold.ts` が単一ソース。

```ts
type ThresholdKind = "input" | "business" | "experience";

interface ThresholdCandidate {
  id: string;
  kind: ThresholdKind;
  area: string;          // 画面/パス目安
  signal: string;        // 何が閾値か
  howToProbe: string;    // どう踏むか
  priority: 1 | 2 | 3;   // 1 が最優先
  expectedBehavior?: string; // 将来用（MVP 未使用）
}
```

`ProductSpec.thresholdCandidates?: ThresholdCandidate[]`

優先度の既定: priority 昇順。同 rank なら `business` → `input` → `experience`。

## Discovery

- LLM が UI／仕様から制限・上限・境界を推論し `thresholdCandidates` に格納
- 空配列可。候補数はプロンプトでおおむね 8–12 に抑制
- パース時に normalize。古いキャッシュで欠落している場合は `[]`
- 既存ユーザーが閾値レーンを使うには `REFRESH_SPEC=1` で再推論が必要な場合がある

## Runtime flow

1. Discovery が候補を出す（踏まない）
2. `assignThresholdCandidates` で M 体に分配（同一 area の重複を避ける）
3. 各 threshold agent:
   - `planBrowserAuth` でログインを試みる（セッション保存はしない）
   - 必要なら API で上限直前状態を仕込む
   - ブラウザで `howToProbe` を実行
   - 壊れた／黙って失敗／メッセージが曖昧 → `post_feedback`
   - 問題なければ次の候補へ（無理に finding を作らない）
4. `check_swarm_signals` で同エリア再現を試みる
5. Triage は既存どおり（threshold 特別扱いなし）

## Error handling

| 状況 | 扱い |
|---|---|
| 候補ゼロ | レーンをスキップ（警告ログ） |
| `MAX_THRESHOLDS=0` | レーン無効 |
| area が存在しない | その候補をスキップ |
| API 仕込み失敗 | ブラウザだけで続行可能な場合は続行、さもなくばスキップ＋ログ |
| ガード抵触 | `SHOAL_MODE` どおり |
| agent 例外 | `AgentLog.status=error`、run 全体は止めない |

## Surfaces

- Swarm UI: 種別 `TH`
- Dashboard StartModal / MCP / `server` spawn: `maxThresholds` → `MAX_THRESHOLDS`
- README / `.env.example`: 設定と `REFRESH_SPEC` 注意

## Testing

- 単体: normalize / sort / assign、discovery パース、runner env、agentType 影響
- 結合: `[threshold]` ログ、Swarm に TH、finding が triage 入力に入る

## Extensibility (post-MVP)

- `expectedBehavior` による期待値判定
- 閾値健全度スコア
- Hall での候補編集
- HR 採用ペルソナ化
- カバレッジ連動の適応的 `MAX_THRESHOLDS`
