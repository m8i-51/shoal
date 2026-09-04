import { describe, it, expect } from "vitest";
import {
  EDGE_RISK_LABEL,
  canCarryEdgeRisk,
  formatEdgeRiskSection,
  formatProductEdgeForPrompt,
  normalizeEdgeRisk,
  normalizeProductEdge,
} from "../product-edge";

describe("normalizeProductEdge", () => {
  it("空白除去・重複排除をして両リストを返す", () => {
    const edge = normalizeProductEdge({
      sharpEdges: ["  Keyboard-first  ", "keyboard-first", ""],
      tradeoffs: ["No wizard"],
    });
    expect(edge).toEqual({
      sharpEdges: ["Keyboard-first"],
      tradeoffs: ["No wizard"],
      source: "discovered",
    });
  });

  it("両方が空なら undefined（空セクションをプロンプトに出さない）", () => {
    expect(normalizeProductEdge({ sharpEdges: [], tradeoffs: [] })).toBeUndefined();
    expect(normalizeProductEdge({ sharpEdges: ["  "], tradeoffs: [123] })).toBeUndefined();
  });

  it("オブジェクト以外は undefined", () => {
    expect(normalizeProductEdge(null)).toBeUndefined();
    expect(normalizeProductEdge("edge")).toBeUndefined();
    expect(normalizeProductEdge(undefined)).toBeUndefined();
  });

  it("片方だけでも成立する", () => {
    expect(normalizeProductEdge({ tradeoffs: ["No onboarding"] })).toEqual({
      sharpEdges: [],
      tradeoffs: ["No onboarding"],
      source: "discovered",
    });
  });

  it("source は human を尊重し、未知の値は defaultSource に落とす", () => {
    expect(normalizeProductEdge({ sharpEdges: ["a"], source: "human" })?.source).toBe("human");
    expect(normalizeProductEdge({ sharpEdges: ["a"], source: "nonsense" }, "human")?.source).toBe("human");
    expect(normalizeProductEdge({ sharpEdges: ["a"] })?.source).toBe("discovered");
  });

  it("項目数と長さに上限をかける", () => {
    const edge = normalizeProductEdge({
      sharpEdges: Array.from({ length: 12 }, (_, i) => `edge ${i}`),
      tradeoffs: ["x".repeat(500)],
    });
    expect(edge?.sharpEdges).toHaveLength(6);
    expect(edge?.tradeoffs[0].length).toBe(240);
  });

  it("updatedAt は文字列のときだけ残す", () => {
    expect(normalizeProductEdge({ sharpEdges: ["a"], updatedAt: "2026-09-02T00:00:00.000Z" })?.updatedAt)
      .toBe("2026-09-02T00:00:00.000Z");
    expect(normalizeProductEdge({ sharpEdges: ["a"], updatedAt: 42 })?.updatedAt).toBeUndefined();
  });
});

describe("normalizeEdgeRisk", () => {
  it("edge と why が揃っているときだけ返す", () => {
    expect(normalizeEdgeRisk({ edge: " Keyboard-first ", why: " Adding a mouse path " }))
      .toEqual({ edge: "Keyboard-first", why: "Adding a mouse path" });
    expect(normalizeEdgeRisk({ edge: "Keyboard-first" })).toBeNull();
    expect(normalizeEdgeRisk({ why: "..." })).toBeNull();
    expect(normalizeEdgeRisk("edge")).toBeNull();
    expect(normalizeEdgeRisk(null)).toBeNull();
  });
});

describe("canCarryEdgeRisk", () => {
  it("bug は尖りを理由に据え置けない", () => {
    expect(canCarryEdgeRisk("bug")).toBe(false);
    expect(canCarryEdgeRisk(" BUG ")).toBe(false);
  });

  it("ux / feature-request / goal-gap は対象になりうる", () => {
    expect(canCarryEdgeRisk("ux")).toBe(true);
    expect(canCarryEdgeRisk("feature-request")).toBe(true);
    expect(canCarryEdgeRisk("goal-gap")).toBe(true);
  });
});

describe("formatProductEdgeForPrompt", () => {
  it("edge が無ければ空文字（プロンプトに何も足さない）", () => {
    expect(formatProductEdgeForPrompt(undefined)).toBe("");
  });

  it("宣言済み edge は両リストと edge_risk の指示を含む", () => {
    const prompt = formatProductEdgeForPrompt({
      sharpEdges: ["Keyboard-first everywhere"],
      tradeoffs: ["No onboarding wizard"],
      source: "human",
    });
    expect(prompt).toContain("declared by the team");
    expect(prompt).toContain("- Keyboard-first everywhere");
    expect(prompt).toContain("- No onboarding wizard");
    expect(prompt).toContain("edge_risk");
    expect(prompt).toContain("Never drop, soften, or merge away a finding");
  });

  it("推論された草案では控えめに flag するよう伝える", () => {
    const prompt = formatProductEdgeForPrompt({ sharpEdges: ["a"], tradeoffs: [], source: "discovered" });
    expect(prompt).toContain("a draft, not a decision");
    expect(prompt).toContain("flag conservatively");
  });
});

describe("formatEdgeRiskSection", () => {
  it("人間が判断できる形で本文に追記する", () => {
    const section = formatEdgeRiskSection({ edge: "Keyboard-first", why: "A mouse path would blunt it" });
    expect(section).toContain("Edge risk — decide before fixing");
    expect(section).toContain("**Edge at stake:** Keyboard-first");
    expect(section).toContain("A mouse path would blunt it");
  });

  it("LLM が書いた edge / why の @mention を無害化する", () => {
    const section = formatEdgeRiskSection({
      edge: "Ask @security-team first",
      why: "Paging @alice would blunt the edge",
    });
    expect(section).toContain("`@security-team`");
    expect(section).toContain("`@alice`");
    expect(section).not.toMatch(/[^`]@security-team/);
    expect(section).not.toMatch(/[^`]@alice/);
  });
});

describe("EDGE_RISK_LABEL", () => {
  it("トラッカーに付けるラベル名は edge-risk", () => {
    expect(EDGE_RISK_LABEL).toBe("edge-risk");
  });
});
