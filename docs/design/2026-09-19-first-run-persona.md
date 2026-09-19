# First-run personas (knowledge + observation subtraction)

**Date:** 2026-09-19  
**Status:** Plan — not implemented  
**Depends on:** behavioral persona contracts (`information` lives on the contract; omitted → `informed`)

## Problem

shoal の本体は、動いているアプリを触って何のサービスかを学習し、そのサービスが何を達成したいかを前提に穴を指摘することだ。ペルソナはその枠の中の観点であって、合格条件ではない。

契約はすでに行動を縛る（同じチュートリアルで飛ばす人と読む人が分かれる）。しかしランタイムはまだ、どのブラウザエージェントの頭にも `[App Overview]`・`[Implemented Features]`・`[App Goals]` を渡し、`read_page_text`・アクセシビリティツリー・コンソール・ネットワーク・`[API check]`・swarm signals を渡している。

「スコアの意味を知らない初見の人」が、仕様書を読んだ探索者のまま動く。画面から何の製品か分からない、という指摘が正直な観察として出ない。プロンプトで「機能一覧は自分の知識にするな」と書くのは引き算ではない。

記事側の引き算（知識と観察チャネルを渡さない）は、shoal を UAT 製品に置き換える思想ではない。群れの学習を捨てると、狙いを突き詰める仕事が消える。逆に、学習結果を**個人の知識として持たない体**を混ぜないと、「その中でペルソナが観点を足す」が看板だけになる。

## Decision

ペルソナ条件 `information: "informed" | "first-run"` を足す。省略時は `informed`（既存の探索者）。

これはプロダクト理解・ゴール・Product Edge を切るモードではない。切替は「その体が学習結果を個人として持つか」だけだ。

| 層 | first-run でも残す | first-run で引く |
|---|---|---|
| 群れ | Product Discovery、ゴール、尖り、トリアージ、API レーン、しきい値レーン、informed なブラウザ | — |
| その体の知識 | 名前 / 役割 / 契約 / 画面上のアプリ名 / 今ランのシナリオ（本人のやりたいこと） / 認証 / 環境 / 本人の記憶 | `[App Overview]` `[Implemented Features]` `[UI-Only Features]` `[Design Context]` `[App Goals]` |
| その体の観察 | `view_screen` `navigate` `click`（description） `fill` `select` `post_feedback` `post_outcome` | `read_page_text` `read_accessibility_tree` `read_console_logs` `read_network_errors` `diff_since_last_action` `run_a11y_audit` `check_swarm_signals` すべての `[API check]` |

引き算はプロンプトのお願いではなく、ブロックを出さない・ツールを渡さない、で強制する。

### モードの単位

既定は**混在**。ラン全体を初見に入れ替える製品切替は作らない。

任意のラン上書きだけ持つ:

- 環境変数 `SHOAL_FIRST_RUN=1`
- ダッシュボード開始ダイアログのチェック（同じフラグ）

効くのは**ブラウザエージェントだけ**。Discovery / トリアージ / API / しきい値 / リグレッションは常に informed。これが「週次の初見パス」であって、shoal の既定ではない。

`MAX_BROWSERS >= 2` かつ `SHOAL_FIRST_RUN` がオフのとき、ディスパッチは first-run のブラウザと informed のブラウザを少なくとも 1 体ずつ優先する。first-run の契約を持つ人は API エクスプローラに回さない（回った場合は informed として走らせ、一度ログする）。

### 採用

新規ユーザー観点の採用で、アクティブ roster に first-run が一人もいなければ `information: "first-run"` を付ける。アクセシビリティ / セキュリティ専門の採用には付けない（診断ツールが仕事だから）。

### トリアージ

カテゴリは増やさない。first-run の「オンボーディングが要る」も finding のまま。`edge-risk` も今どおり。放棄は仮説であって正解ではない。finding / `AgentLog` に `information?: "first-run"` を付け、どの観点かを後から読めるようにする。

## Non-goals (v1)

- A/B スコアやスクリーンショット同士の選好
- click 不能な screenshot-only（description 指定の click は残す）
- 群れ全体の既定を貧しさにする
- Product Discovery やゴールを止める
- 知識引き算と観察引き算を別フラグにする（v1 は `first-run` に束ねる）
- API / しきい値 / リグレッションへ first-run を適用する
- Product Edge の判定ロジック変更
- 放棄レポートを正解扱いする

## Data model

`framework/persona-contract.ts`（契約があるとき）:

```ts
export const PERSONA_INFORMATION = ["informed", "first-run"] as const;
export type PersonaInformation = (typeof PERSONA_INFORMATION)[number];

export interface PersonaContract {
  traits: string;
  behavioralRules: PersonaBehavioralRules;
  knowledgeBoundary: PersonaKnowledgeBoundary;
  stateRules: PersonaStateRules;
  abandonment: string[];
  /** Omitted on legacy contracts → informed. */
  information?: PersonaInformation;
}

export function personaInformation(
  contract: PersonaContract | undefined,
): PersonaInformation {
  return contract?.information === "first-run" ? "first-run" : "informed";
}
```

パース: 欠落・未知値は `informed`。`"first-run"` だけが初見。`never` 分岐を switch に置く。

ラン上書き:

```ts
export function effectiveInformation(
  contract: PersonaContract | undefined,
  opts: { firstRunAllBrowsers: boolean; lane: "browser" | "explorer" | "threshold" | "regression" },
): PersonaInformation {
  switch (opts.lane) {
    case "explorer":
    case "threshold":
    case "regression":
      return "informed";
    case "browser":
      return opts.firstRunAllBrowsers ? "first-run" : personaInformation(contract);
    default: {
      const _exhaustive: never = opts.lane;
      return _exhaustive;
    }
  }
}
```

`SHOAL_FIRST_RUN` は `"1"` のときだけ true。他レーンでは契約も env も無視する。

## Runtime

1. Product Discovery は今どおり（仕様・ゴール・尖り・閾値候補を作る）。
2. Org / HR は今どおり採用する。契約に `information` を書く。
3. `splitRosterForDispatch` は browser 枠を取るとき first-run を固定ペルソナの次に優先する。
4. 各ブラウザセッション:
   - `effectiveInformation === "first-run"` ならツールを first-run 集合にフィルタする。
   - プロンプトから仕様ブロックと観察ツールの手順を落とす。代わりに `[What you know]` を入れる。
   - `click` の description から a11y ref の案内を外す。
5. トリアージは既存。edge 宣言があれば first-run 由来でも `edge-risk` を付けてよい。

`[What you know]`（first-run のみ）:

```
[What you know]
You have not been briefed on this product. There is no feature list and no goal list in your head.
Use the screen and your behavioral contract. You cannot read page source, console, network, the accessibility tree, or other agents' reports.
```

informed 側の契約文「`[Implemented Features]` は群れの背景」は、first-run では出さない（ブロック自体が無い）。代わりに「画面が製品だ」と書く。

シナリオ `[Your Task for This Run]` は残す。それは仕様ではなく、この人が今やりたいことだ。

## Surfaces

- Personas パネル: 契約の「情報」— 探索者 / 初見（画面だけ）。ヒント: 初見は仕様もログも渡さない。
- 開始ダイアログ: 「この run のブラウザを全員初見にする」（default off）。`SHOAL_MODE`（セーフティ）とは別。
- `personas.example.yaml`: 初見ユーザーは `information: first-run`。a11y / セキュリティは省略（informed）。
- README / `.env.example`: `SHOAL_FIRST_RUN`
- Swarm / AgentLog: first-run ならログに出す

## Files

| File | Change |
|---|---|
| `framework/persona-contract.ts` | `PersonaInformation`、パース、`personaInformation`、生成 SPEC / tool schema、`formatPersonaContract` の分岐 |
| `framework/agent-tools.ts` | `browserToolsForInformation(tools, information)`。first-run は許可名だけ + `[API check]` 除外。click 説明を切替 |
| `framework/browser-prompt.ts`（新規） | `formatProductBrief(spec, information)` と観察手順ブロック。`run.ts` から仕様文字列を移す |
| `run.ts` | ブラウザだけ `effectiveInformation`。ツールと brief を切替。explorer / threshold / regression は触らない |
| `framework/roster.ts` | browser 取得時、first-run を固定の次に優先 |
| `framework/org-designer.ts` / `persona-from-seed.ts` / HR `add_agent` | 混在ルールを生成 SPEC に書く |
| `framework/persona-pack.ts` | YAML の `information` を契約パースに乗せる（追加作業はパース側） |
| `framework/types.ts` | `Finding.information?` / `AgentLog.information?` |
| `server/index.ts` `server/runner.ts` `server/mcp.ts` | `firstRun?: boolean` → `SHOAL_FIRST_RUN=1` |
| `web/src/components/PersonasPanel.tsx` | 契約の情報切替 |
| `web/src/components/StartModal.tsx` | チェックボックス |
| `web/src/i18n/en.json` `ja.json` | コピー |
| `personas.example.yaml` README `.env.example` | 例と変数 |
| この ADR と `docs/README.md` | 索引 |

`run.ts` のプロンプトをテストするため、仕様ブロックは必ず `browser-prompt.ts` に出す。インラインのまま断言しない。

## Testing

単体（必須）:

- パース: 省略 → informed、`"first-run"` → first-run、未知値 → informed
- `formatProductBrief(first-run)` に `Implemented Features` / `App Goals` / 機能文面が無い。`formatProductBrief(informed)` にはある
- `browserToolsForInformation(first-run)` の name が許可リストと一致し、`read_page_text` 等が無い。informed は今の集合のまま
- `effectiveInformation`: explorer/threshold/regression は env が 1 でも informed。browser + env 1 は契約無視で first-run
- `splitRosterForDispatch`: first-run が browser 枠に入る
- PATCH `/api/personas/:id` が `information: "first-run"` を保存する。開始 API が `firstRun: true` を runner env に渡す

結合:

- ログに `[browser:first-run]`
- finding JSON に `information: "first-run"` が乗る（そのエージェントのとき）

## Implementation order

1. 型・パース・`personaInformation` / `effectiveInformation` とテスト
2. `formatProductBrief` + `browserToolsForInformation` とテスト（ここが引き算の本体）
3. `run.ts` のブラウザレーンに接続。ログと finding に `information` を書く
4. roster の優先と HR/seed/YAML/example
5. ダッシュボード（ペルソナ切替 + 開始ダイアログ）と i18n
6. `SHOAL_FIRST_RUN` を server/runner/MCP/README に通す
7. 契約 ADR の Out of scope「screenshot-only naive lane」を、この ADR を指す一文に更新する（契約側が main に入ったあと）

各ステップでテストを先に赤、実装、緑。`npx tsc --noEmit` と対象 vitest。UI を触ったら `npm run build:web`。
