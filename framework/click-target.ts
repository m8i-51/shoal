import type { Locator, Page } from "playwright";

const ROLE_WORDS = /\b(buttons?|links?|tabs?|icons?|menus?|items?|checkboxes?|dialogs?|modals?|overlays?|tooltips?)\b/gi;
const JP_ROLE_WORDS = /ボタン|リンク|タブ|アイコン|メニュー|ダイアログ|モーダル|オーバーレイ/g;

const CLICKABLE_ROLES = [
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "radio",
  "switch",
  "option",
  "treeitem",
  "combobox",
] as const;

const SNAPSHOT_CLICKABLE = new Set<string>([...CLICKABLE_ROLES, "img", "generic", "searchbox", "textbox"]);

function addCandidate(out: string[], value: string): void {
  const t = value.replace(/\s+/g, " ").trim();
  if (t && !out.includes(t)) out.push(t);
}

/** エージェントの説明文から、accessible name になりそうな短い候補を先に返す */
export function clickNameCandidates(description: string): string[] {
  const trimmed = description.trim();
  if (!trimmed) return [];
  const out: string[] = [];

  for (const m of trimmed.matchAll(/["'「『]([^"'」』]+)["'」』]/g)) {
    addCandidate(out, m[1]);
  }

  const beforeOn = trimmed.split(/\s+(?:on|in|of)\s+the\s+/i)[0] ?? trimmed;
  const noParens = beforeOn.replace(/[（(][^）)]*[）)]/g, " ");
  const noRoles = noParens.replace(ROLE_WORDS, " ").replace(JP_ROLE_WORDS, " ");
  addCandidate(out, noRoles);
  addCandidate(out, noParens);
  for (const m of beforeOn.matchAll(/[（(]([^）)]+)[）)]/g)) {
    addCandidate(out, m[1]);
  }
  addCandidate(out, beforeOn);
  addCandidate(out, trimmed);
  return out;
}

export function extractAriaRef(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const tagged = trimmed.match(/\[ref=([A-Za-z]\w*)\]/);
  if (tagged) return tagged[1];
  const assigned = trimmed.match(/(?:^|\s)ref=([A-Za-z]\w*)(?:\s|$)/);
  if (assigned) return assigned[1];
  if (/^e\d+$/i.test(trimmed)) return trimmed;
  return undefined;
}

function scoreAccessibleName(name: string, description: string, candidates: string[]): number {
  const n = name.trim().toLowerCase();
  const d = description.trim().toLowerCase();
  if (!n) return 0;

  for (const c of candidates) {
    if (n === c.trim().toLowerCase()) return 200 + n.length;
  }
  if (d.includes(n)) {
    if (n.length <= 1 && !candidates.some((c) => c.trim().toLowerCase() === n)) return 0;
    return 80 + n.length;
  }
  for (const c of candidates) {
    const cl = c.trim().toLowerCase();
    if (!cl) continue;
    if (n.includes(cl) || cl.includes(n)) return 40 + Math.min(n.length, cl.length);
  }
  return 0;
}

/** アクセシビリティツリーから、説明に最も合う clickable ノードの ref を返す */
export function bestAriaRefFromSnapshot(snapshot: string, description: string): string | undefined {
  const candidates = clickNameCandidates(description);
  let bestRef: string | undefined;
  let bestScore = 0;

  for (const line of snapshot.split("\n")) {
    const refMatch = line.match(/\[ref=([A-Za-z]\w*)\]/);
    if (!refMatch) continue;
    const roleMatch = line.match(/^\s*-\s+(\S+)/);
    const role = (roleMatch?.[1] ?? "").replace(/:$/, "");
    if (role && !SNAPSHOT_CLICKABLE.has(role)) continue;
    const nameMatch = line.match(/"([^"]*)"/);
    const name = nameMatch?.[1] ?? "";
    const score = scoreAccessibleName(name, description, candidates);
    if (score === 0) continue;
    const total = score + (SNAPSHOT_CLICKABLE.has(role) ? 10 : 0);
    if (total > bestScore) {
      bestScore = total;
      bestRef = refMatch[1];
    }
  }

  return bestScore >= 50 ? bestRef : undefined;
}

async function firstIfPresent(locator: Locator): Promise<Locator | null> {
  try {
    if ((await locator.count()) === 0) return null;
    return locator.first();
  } catch {
    return null;
  }
}

export function clickToolHasTarget(input: { description?: string; ref?: string }): boolean {
  return Boolean(input.ref?.trim() || input.description?.trim());
}

export async function resolveClickLocator(
  page: Page,
  input: { description?: string; ref?: string },
): Promise<Locator | null> {
  const description = input.description?.trim() ?? "";
  const ref = input.ref?.trim() || extractAriaRef(description);

  if (ref) {
    const byRef = await firstIfPresent(page.locator(`aria-ref=${ref}`));
    if (byRef) return byRef;
  }

  for (const name of clickNameCandidates(description)) {
    for (const role of CLICKABLE_ROLES) {
      const found = await firstIfPresent(page.getByRole(role, { name }));
      if (found) return found;
    }
    const byText = await firstIfPresent(page.getByText(name, { exact: false }));
    if (byText) return byText;
  }

  try {
    const snapshot = await page.ariaSnapshot({ mode: "ai", depth: 8 });
    const snapRef = bestAriaRefFromSnapshot(snapshot, description);
    if (snapRef) {
      const bySnap = await firstIfPresent(page.locator(`aria-ref=${snapRef}`));
      if (bySnap) return bySnap;
    }
  } catch {
    // snapshot が取れなくてもクリック自体は失敗させる
  }

  return null;
}

export async function clickDescribedElement(
  page: Page,
  input: { description?: string; ref?: string },
  timeout = 5000,
): Promise<void> {
  const loc = await resolveClickLocator(page, input);
  if (!loc) {
    const hint = input.ref?.trim()
      ? `ref=${input.ref.trim()}`
      : (input.description?.trim() || "(no description or ref)");
    throw new Error(`No element matching: ${hint}`);
  }
  await loc.click({ timeout });
}
