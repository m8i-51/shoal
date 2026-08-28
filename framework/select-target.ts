import type { Locator, Page } from "playwright";

export type SelectOption = { label: string; value: string };

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Pick a native <option> by exact then partial accessible name / value. */
export function pickMatchingOption(
  options: SelectOption[],
  requested: string,
): SelectOption | undefined {
  const q = norm(requested);
  if (!q || options.length === 0) return undefined;

  const exactLabel = options.find((o) => norm(o.label) === q);
  if (exactLabel) return exactLabel;

  const exactValue = options.find((o) => norm(o.value) === q);
  if (exactValue) return exactValue;

  return options.find((o) => {
    const label = norm(o.label);
    const value = norm(o.value);
    return (label.length > 0 && (label.includes(q) || q.includes(label)))
      || (value.length > 0 && (value.includes(q) || q.includes(value)));
  });
}

async function readOptions(select: Locator): Promise<SelectOption[]> {
  return select.locator("option").evaluateAll((nodes) =>
    nodes.map((n) => {
      const el = n as HTMLOptionElement;
      return { label: (el.textContent ?? "").trim(), value: el.value };
    }),
  );
}

async function trySelect(
  el: Locator,
  requested: string,
  timeout: number,
): Promise<boolean> {
  try {
    await el.selectOption({ label: requested }, { timeout });
    return true;
  } catch { /* next */ }
  try {
    await el.selectOption({ value: requested }, { timeout });
    return true;
  } catch { /* next */ }

  let options: SelectOption[] = [];
  try {
    options = await readOptions(el);
  } catch {
    return false;
  }
  const match = pickMatchingOption(options, requested);
  if (!match) return false;
  try {
    await el.selectOption({ label: match.label }, { timeout });
    return true;
  } catch {
    try {
      await el.selectOption({ value: match.value }, { timeout });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Select a dropdown option using exact then partial label / value match.
 * Tries native <select> first, then option roles (custom combobox).
 */
export async function selectDescribedOption(
  page: Page,
  input: { label: string; value: string },
  timeout = 5000,
): Promise<void> {
  const { label, value } = input;
  const byAriaLabel = page.getByLabel(label, { exact: false });
  const byContainer = page
    .locator("div")
    .filter({ has: page.locator("label", { hasText: label }) })
    .locator("select")
    .first();

  const short = Math.min(1500, timeout);
  for (const el of [byAriaLabel, byContainer]) {
    if (await trySelect(el, value, short)) return;
  }

  // Custom dropdown: click an option whose accessible name contains the value.
  try {
    const option = page.getByRole("option", { name: value });
    if ((await option.count()) > 0) {
      await option.first().click({ timeout });
      return;
    }
  } catch { /* fall through */ }

  throw new Error(`Could not select "${value}" in "${label}"`);
}
