/**
 * Product Edge — 「このプロダクトが意図的に尖らせているところ」の宣言。
 *
 * 多様なペルソナの指摘をすべて直すと、プロダクトは平均に寄って尖りを失う
 * （ドッグフーディングで出たフィードバック）。triage はチケットが生まれる
 * 最後のゲートなので、ここで「直すと尖りが鈍る指摘」に印を付けて人間に渡す。
 * 指摘そのものは決して握りつぶさない — 判断材料を可視化するだけ。
 */

export type ProductEdgeSource = "discovered" | "human";

export interface ProductEdge {
  /** What the product is deliberately sharp about — worth protecting even when it costs convenience. */
  sharpEdges: string[];
  /** Deliberate trade-offs / non-goals — accepted costs, not defects. */
  tradeoffs: string[];
  /** Who wrote it. A team declaration outranks an inferred draft. */
  source: ProductEdgeSource;
  updatedAt?: string;
}

/** The declared edge a fix would blunt, and why. Attached to an issue by triage. */
export interface EdgeRisk {
  edge: string;
  why: string;
}

/** Label attached to issues whose obvious fix would blunt a declared edge. */
export const EDGE_RISK_LABEL = "edge-risk";

/**
 * Categories that are defects regardless of positioning — an edge never excuses them,
 * so triage may not mark them as edge risks even if the model asks to.
 */
export const EDGE_RISK_EXEMPT_CATEGORIES = ["bug"];

const MAX_ITEMS = 6;
const MAX_ITEM_CHARS = 240;
const MAX_WHY_CHARS = 600;

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_ITEM_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function asSource(raw: unknown, fallback: ProductEdgeSource): ProductEdgeSource {
  return raw === "human" || raw === "discovered" ? raw : fallback;
}

/**
 * Sanitize raw edge data — discovery output, a cached spec, or a dashboard payload.
 * Returns undefined when nothing usable survives, so an empty edge never reaches a
 * prompt as an empty section.
 */
export function normalizeProductEdge(
  raw: unknown,
  defaultSource: ProductEdgeSource = "discovered",
): ProductEdge | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const sharpEdges = normalizeList(o.sharpEdges);
  const tradeoffs = normalizeList(o.tradeoffs);
  if (sharpEdges.length === 0 && tradeoffs.length === 0) return undefined;
  const edge: ProductEdge = { sharpEdges, tradeoffs, source: asSource(o.source, defaultSource) };
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt.trim() : "";
  if (updatedAt) edge.updatedAt = updatedAt;
  return edge;
}

/** Drop an edge risk that is missing either half, or that names an exempt category. */
export function normalizeEdgeRisk(raw: unknown): EdgeRisk | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const edge = typeof o.edge === "string" ? o.edge.trim().slice(0, MAX_ITEM_CHARS) : "";
  const why = typeof o.why === "string" ? o.why.trim().slice(0, MAX_WHY_CHARS) : "";
  if (!edge || !why) return null;
  return { edge, why };
}

/** A defect is a defect: positioning never justifies broken behavior. */
export function canCarryEdgeRisk(category: string): boolean {
  return !EDGE_RISK_EXEMPT_CATEGORIES.includes(category.trim().toLowerCase());
}

const SOURCE_NOTE: Record<ProductEdgeSource, string> = {
  human: "declared by the team — authoritative",
  discovered: "inferred from the app itself — a draft, not a decision",
};

/** The `[Product Edge]` block handed to the triage agent. Empty string when no edge is declared. */
export function formatProductEdgeForPrompt(edge?: ProductEdge): string {
  if (!edge) return "";
  const lines = [`[Product Edge — what this product is deliberately sharp about (${SOURCE_NOTE[edge.source]})]`];
  if (edge.sharpEdges.length > 0) {
    lines.push("Sharp edges (worth protecting even when they cost convenience):");
    lines.push(...edge.sharpEdges.map((e) => `- ${e}`));
  }
  if (edge.tradeoffs.length > 0) {
    lines.push("Deliberate trade-offs (accepted costs, not defects):");
    lines.push(...edge.tradeoffs.map((t) => `- ${t}`));
  }
  lines.push(
    "",
    "A crowd of personas each asking for the conventional version of this app is how a product loses its edge.",
    "Never drop, soften, or merge away a finding because it touches an edge — file it exactly as you would otherwise.",
    "But when the obvious fix would sand down a sharp edge or reverse a deliberate trade-off — \"make it behave like",
    "every other app\", \"add the option this persona expects\", \"simplify it until nobody has to learn anything\" —",
    "pass edge_risk to create_issue, naming the edge at stake and why acting on the finding would blunt it.",
    "A human decides whether the edge or the finding wins; your job is to make that a visible choice, not to pick.",
    "Never set edge_risk on broken behavior, data loss, security, or accessibility findings: those are defects",
    edge.source === "discovered"
      ? "whatever the positioning — and this edge is only an inferred draft, so flag conservatively."
      : "whatever the positioning.",
  );
  return lines.join("\n");
}

/** Markdown appended to an issue body when triage flags an edge risk. Renders on every tracker. */
export function formatEdgeRiskSection(risk: EdgeRisk): string {
  return [
    "",
    "---",
    "**⚠️ Edge risk — decide before fixing**",
    "",
    `- **Edge at stake:** ${risk.edge}`,
    `- **Why the obvious fix would blunt it:** ${risk.why}`,
    "",
    "Fixing this as reported moves the product toward the conventional version of itself.",
    "Keep the edge, adapt the fix, or accept the finding — but make it a decision, not a default.",
  ].join("\n");
}
