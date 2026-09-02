/**
 * agent-tools.ts — tool schemas the agents are given.
 *
 * These are declarations, not behavior: the handlers live in browser-tools.ts
 * (browser lane) and run.ts's `makeExecutor` (API lane). They were inline in
 * run.ts, where ~270 lines of JSON schema buried the orchestration logic.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "./llm-client";
import { SUGGESTED_DEVICES } from "./environment";

// ================================================================
// API agent tools
// ================================================================

export const POST_FEEDBACK_TOOL: Tool = {
  name: "post_feedback",
  description: "Record a finding about the app — usability issues, feature requests, or bug-like behavior. / アプリへのフィードバックを記録する",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: {
        type: "string",
        description: `Describe the finding. Tone varies by category:
- bug: technical — state what happened, what was expected, and steps to reproduce.
- ux: experiential — write from the user's perspective ("I tried to...", "It was hard to find...", "I got confused when...").
- feature-request: aspirational — describe what you wished you could do ("It would have been helpful if...", "I wanted to...").
- goal-gap: goal-oriented — explain which goal was blocked and why ("I was trying to achieve X, but couldn't because...").`,
      },
      category: { type: "string", enum: ["ux", "feature-request", "bug", "goal-gap"] },
    },
    required: ["title", "body", "category"],
  },
};

export const REPORT_REGRESSION_TOOL: Tool = {
  name: "report_regression",
  description: "Report a regression when a previously fixed bug has reappeared as an issue ticket. / 修正済みバグの再発を issue チケットとして報告する",
  input_schema: {
    type: "object",
    properties: {
      original_issue_number: {
        type: "string",
        description: "The issue identifier exactly as shown in the issue list (e.g. 'PROJ-55' for Backlog, '42' for GitHub)",
      },
      original_issue_title: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["original_issue_number", "original_issue_title", "title", "body"],
  },
};

export const MARK_VERIFIED_TOOL: Tool = {
  name: "mark_verified",
  description: "Record that a closed Issue has been verified as still fixed. / 修正済みIssueが問題なく修正されていることを確認した場合に呼ぶ",
  input_schema: {
    type: "object",
    properties: {
      original_issue_number: {
        type: "string",
        description: "The issue identifier exactly as shown in the issue list (e.g. 'PROJ-55' for Backlog, '42' for GitHub)",
      },
      original_issue_title: { type: "string" },
      note: { type: "string" },
    },
    required: ["original_issue_number", "original_issue_title", "note"],
  },
};

export const SWARM_SIGNALS_TOOL: Tool = {
  name: "check_swarm_signals",
  description: "See what OTHER agents exploring this app right now have reported. If a signal is relevant to your persona or the area you are in, try to reproduce it from your own perspective — a finding confirmed by multiple different personas becomes a much stronger issue. If you reproduce one, report it with post_feedback in your own words (your experience, not theirs). / 同じ run の他のエージェントが報告した発見を確認する。自分のペルソナで再現できた発見は post_feedback で自分の言葉で報告する",
  input_schema: { type: "object", properties: {}, required: [] },
};

export const POST_OUTCOME_TOOL: Tool = {
  name: "post_outcome",
  description: "Record whether you achieved your scenario goal. Call this at the end of your run if you were given a [Your Task for This Run] section. / [Your Task for This Run] セクションがある場合のみ、run の最後にゴール達成可否を記録する",
  input_schema: {
    type: "object",
    properties: {
      achieved: {
        type: "boolean",
        description: "true if you successfully completed the goal, false if you could not",
      },
      reason: {
        type: "string",
        description: "Brief explanation (1-2 sentences) of why the goal was or was not achieved",
      },
    },
    required: ["achieved", "reason"],
  },
};

/** Tools an API explorer agent gets, on top of the target's own app tools. */
export function explorerTools(appTools: Tool[]): Tool[] {
  return [...appTools, POST_FEEDBACK_TOOL, POST_OUTCOME_TOOL, SWARM_SIGNALS_TOOL];
}

/** Tools the API-lane regression agent gets. */
export function regressionTools(appTools: Tool[]): Tool[] {
  return [...appTools, REPORT_REGRESSION_TOOL, MARK_VERIFIED_TOOL];
}

// ================================================================
// Persona designer (HR agent) tools
// ================================================================

export const PERSONA_DESIGNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_agents",
    description: "Get the current list of registered agents. / 現在登録されているエージェント一覧を取得する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_coverage",
    description: "Get a weighted summary of what has been explored across past runs. Use this to identify underrepresented lenses and perspectives before deciding whom to hire. / 過去のrunで何がどれだけ探索されたかの重み付きサマリーを取得する。採用方針の決定前に確認すること",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_path_coverage",
    description: "Get site-map coverage vs known paths (unvisited / reached / explored rates), plus paths touched in the most recent run. Use this to recruit agents who will naturally fill coverage gaps. / 既知パスに対するサイトマップ網羅（未訪問・reached・explored・％）と直近runで触ったパスを取得する。網羅の穴を埋めるペルソナ採用に使う",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_finding_hotspots",
    description: "Get URL areas where findings have clustered across all past runs. Use this to understand which parts of the app have been thoroughly investigated vs. overlooked — recruit agents to explore under-investigated areas, or specialists to deep-dive problem hotspots. / 過去のrun全体でfindingsが集中しているURLエリアを取得する。十分に調査済みのエリアと見落とされているエリアを把握し、未探索エリアへの新エージェント採用や問題多発エリアへのスペシャリスト派遣に活かす",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_persona_templates",
    description: "Get the persona template pack defined for this project. Prefer these archetypes when adding agents — adapt names/details to fit the app context but keep the role intact. / このプロジェクト用に定義されたペルソナテンプレート一覧を取得する。エージェントを追加する際はまずこのテンプレートから選ぶこと",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_open_issues",
    description: "Get the titles and labels of currently open issue tickets (known problems). Use this to understand what is already known and recruit agents who are likely to explore DIFFERENT areas. / 現在オープンな issue チケットのタイトルとラベルを取得する。既知の問題を把握し、未探索領域を掘れるペルソナを採用するために使う",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_scenarios",
    description: "Get the user test scenarios generated for this run. About 70% of agents will be assigned one of these scenarios — recruit personas whose background and role naturally fit the scenario contexts. / 今回のrunで生成されたユーザーシナリオ一覧を取得する。エージェントの約70%にシナリオが割り当てられるため、シナリオの文脈に自然にフィットするペルソナを採用すること",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_agent",
    description: "Register a new agent (user persona). / 新しいエージェントを登録する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string", description: "Narrative role (may be a description of the person)" },
        accountRole: {
          type: "string",
          description: "Short test-account role token such as user, instructor, or admin — not a narrative description",
        },
        persona: { type: "string" },
        environment: {
          type: "object",
          description: `Optional browsing environment — make it match the persona's life (e.g. a commuting sales rep browses on a phone over a slow connection). Give 1-2 recruits a non-desktop environment. Omit entirely for a standard desktop user.
- device: Playwright device name, e.g. ${SUGGESTED_DEVICES.map((d) => `"${d}"`).join(", ")} (omit for desktop)
- locale: BCP 47 locale like "ja-JP"
- colorScheme: "dark" or "light"
- reducedMotion: true for users who prefer reduced motion
- networkThrottle: "slow-3g" or "fast-3g" for slow connections`,
          properties: {
            device: { type: "string" },
            locale: { type: "string" },
            colorScheme: { type: "string", enum: ["light", "dark"] },
            reducedMotion: { type: "boolean" },
            networkThrottle: { type: "string", enum: ["slow-3g", "fast-3g"] },
          },
        },
      },
      required: ["name", "role", "persona"],
    },
  },
  {
    name: "retire_agent",
    description: "Retire an agent (e.g. due to long tenure). / エージェントを退職させる",
    input_schema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["agentId", "reason"],
    },
  },
];

// ================================================================
// Browser agent tools
// ================================================================

/**
 * Tools a browser agent gets. The target's API tools are offered as read-only
 * cross-checks ("[API check]") only when the API lane is enabled.
 */
export function browserTools(appTools: Tool[], includeApiTools: boolean): Anthropic.Tool[] {
  return [
    ...(includeApiTools ? appTools.map((t) => ({ ...t, description: `[API check] ${t.description}` })) : []),
    SWARM_SIGNALS_TOOL,
    {
      name: "run_a11y_audit",
      description: "Run an automated WCAG accessibility audit (axe-core) on the CURRENT page. Returns measured violations (contrast, missing alt, labels, ARIA…) with impact levels and affected elements. Use it when your persona or lens involves accessibility, or when a page feels hard to read or navigate — then cite the specific rules and elements as evidence in post_feedback. / 現在のページで axe-core による WCAG 監査を実行し、実測の違反一覧を得る",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "view_screen",
      description: "Capture the current screen. / 現在の画面を確認する",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "navigate",
      description: "Navigate to a path. / 指定したパスに移動する",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "click",
      description: "Click a button, link, or tab on screen. Prefer the accessible name and/or ref from read_accessibility_tree (e.g. e12). description is optional when ref is set. / 画面上の要素をクリックする。accessible name またはアクセシビリティツリーの ref で対象を指定する",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Accessible name or a description of the control (partial name match is OK). Optional when ref is set." },
          ref: { type: "string", description: "Optional accessibility-tree ref from read_accessibility_tree, e.g. e12" },
        },
        required: [],
      },
    },
    {
      name: "fill",
      description: "Type text into an input field. / 入力フィールドにテキストを入力する",
      input_schema: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
        },
        required: ["label", "value"],
      },
    },
    {
      name: "select",
      description: "Select an option from a dropdown. / ドロップダウンで選択する",
      input_schema: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
        },
        required: ["label", "value"],
      },
    },
    {
      name: "diff_since_last_action",
      description: "Check what changed on the page since the last action. / 直前のアクションでページに何が変わったかを確認する",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "read_page_text",
      description: "Get all visible text on the page. / ページ上の表示テキストをすべて取得する",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "read_accessibility_tree",
      description: "Get the page's accessibility tree (includes [ref=eN] ids you can pass to click). / ページのアクセシビリティツリーを取得する。要素の ref を click に渡せる",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "read_console_logs",
      description: "Check browser console logs (errors and warnings). / ブラウザのコンソールログを確認する",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "read_network_errors",
      description: "Check failed API requests. / 失敗したAPIリクエストの一覧を確認する",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "post_feedback",
      description: "Record an issue or improvement as feedback. Becomes an issue ticket after triage. / 問題・改善点をフィードバックとして記録する（triage 後に issue チケット化される）",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          category: { type: "string", enum: ["ux", "feature-request", "bug", "goal-gap"] },
        },
        required: ["title", "body", "category"],
      },
    },
    {
      name: "post_outcome",
      description: "Record whether you achieved your scenario goal. Call this at the end of your run if you were given a [Your Task for This Run] section. / [Your Task for This Run] セクションがある場合のみ、run の最後にゴール達成可否を記録する",
      input_schema: {
        type: "object",
        properties: {
          achieved: { type: "boolean", description: "true if you successfully completed the goal, false if you could not" },
          reason: { type: "string", description: "Brief explanation (1-2 sentences)" },
        },
        required: ["achieved", "reason"],
      },
    },
  ];
}
