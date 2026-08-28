/**
 * catalog-pick.ts
 * 課題トラッカーの課題タイプ / 優先度を、指摘カテゴリから選ぶ。
 * 名前の対応（バグ・要望・タスクなど）を優先し、判断できないときだけモデルに選ばせる。
 */
import { createLLMClient } from "../llm-client";
import { completeText } from "../tool-session";

export interface CatalogItem {
  id: string;
  name: string;
}

export type FindingCategory = "bug" | "ux" | "feature-request" | "goal-gap";
export type CatalogKind = "issueType" | "priority";

export type ModelPicker = (
  items: CatalogItem[],
  category: FindingCategory,
  kind: CatalogKind,
) => Promise<CatalogItem | null>;

const TYPE_SYNONYMS: Record<FindingCategory, string[]> = {
  bug: ["バグ", "bug", "defect", "不具合", "障害", "エラー", "error"],
  ux: ["ux", "ui", "改善", "usability", "使いやすさ", "タスク", "task"],
  "feature-request": ["要望", "機能要望", "feature", "request", "機能", "提案", "enhancement", "story", "ストーリー"],
  "goal-gap": ["ゴール", "gap", "goal", "要望", "feature", "タスク", "task"],
};

const PRIORITY_SYNONYMS: Record<FindingCategory, string[]> = {
  bug: ["高", "high", "highest", "urgent", "緊急", "critical", "major"],
  ux: ["中", "medium", "normal", "mid"],
  "feature-request": ["中", "medium", "normal", "低", "low"],
  "goal-gap": ["中", "medium", "normal"],
};

export function categoryFromLabels(labels: string[]): FindingCategory {
  for (const label of labels) {
    const n = label.trim().toLowerCase();
    switch (n) {
      case "bug":
      case "regression":
        return "bug";
      case "ux":
        return "ux";
      case "feature-request":
        return "feature-request";
      case "goal-gap":
        return "goal-gap";
      default:
        break;
    }
  }
  return "ux";
}

function synonymsFor(category: FindingCategory, kind: CatalogKind): string[] {
  switch (kind) {
    case "issueType":
      return TYPE_SYNONYMS[category];
    case "priority":
      return PRIORITY_SYNONYMS[category];
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function scoreName(itemName: string, synonyms: string[]): number {
  const n = normalize(itemName);
  if (!n) return 0;
  let best = 0;
  for (let i = 0; i < synonyms.length; i++) {
    const syn = normalize(synonyms[i]);
    if (!syn) continue;
    if (n === syn) {
      best = Math.max(best, 1000 - i);
      continue;
    }
    if (n.includes(syn) || syn.includes(n)) {
      best = Math.max(best, 100 - i);
    }
  }
  return best;
}

export function pickByName(
  items: CatalogItem[],
  category: FindingCategory,
  kind: CatalogKind,
): CatalogItem | null {
  const synonyms = synonymsFor(category, kind);
  let best: CatalogItem | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreName(item.name, synonyms);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

export async function defaultPickWithModel(
  items: CatalogItem[],
  category: FindingCategory,
  kind: CatalogKind,
): Promise<CatalogItem | null> {
  if (items.length === 0) return null;
  try {
    const { client, defaultModel, provider } = createLLMClient();
    const kindLabel = kind === "issueType" ? "issue type" : "priority";
    const text = await completeText({
      provider,
      client,
      model: defaultModel,
      maxTokens: 80,
      system: `You pick a ${kindLabel} for a software issue tracker. Reply with only the id of the best match.`,
      userPrompt: [
        `Finding category: ${category}`,
        "Options:",
        ...items.map((i) => `- id=${i.id} name=${i.name}`),
        "",
        "Reply with the id only.",
      ].join("\n"),
    });
    const trimmed = text.trim();
    const exact = items.find((i) => i.id === trimmed);
    if (exact) return exact;
    const tokens = trimmed.split(/[\s,:=]+/).filter(Boolean);
    const byLongest = [...items].sort((a, b) => b.id.length - a.id.length);
    return byLongest.find((i) => tokens.includes(i.id)) ?? null;
  } catch (e) {
    console.warn(`[trackers] model picker failed for ${kind}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function pickCatalogItem(options: {
  items: CatalogItem[];
  category: FindingCategory;
  kind: CatalogKind;
  logPrefix?: string;
  pickWithModel?: ModelPicker;
}): Promise<CatalogItem | null> {
  const { items, category, kind, logPrefix = "[trackers]", pickWithModel } = options;
  if (items.length === 0) return null;

  const named = pickByName(items, category, kind);
  if (named) {
    console.log(
      `${logPrefix} selected ${kind} "${named.name}" (id=${named.id}) for category=${category} (name match)`,
    );
    return named;
  }

  const picker = pickWithModel ?? defaultPickWithModel;
  const fromModel = await picker(items, category, kind);
  if (fromModel) {
    console.log(
      `${logPrefix} selected ${kind} "${fromModel.name}" (id=${fromModel.id}) for category=${category} (model)`,
    );
    return fromModel;
  }

  const fallback = items[0] ?? null;
  if (fallback) {
    console.warn(
      `${logPrefix} could not match ${kind} for category=${category}; falling back to "${fallback.name}" (id=${fallback.id})`,
    );
  }
  return fallback;
}

export function toCatalogItems(raw: unknown): CatalogItem[] {
  if (!Array.isArray(raw)) return [];
  const items: CatalogItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { id?: unknown; name?: unknown };
    if (rec.id === undefined || rec.id === null || typeof rec.name !== "string") continue;
    items.push({ id: String(rec.id), name: rec.name });
  }
  return items;
}
