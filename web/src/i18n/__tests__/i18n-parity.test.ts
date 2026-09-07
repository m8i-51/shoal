import { describe, it, expect } from "vitest";
import en from "../en.json";
import ja from "../ja.json";

/**
 * Locks in two properties of the en/ja translation files that a previous
 * round got wrong: thirteen ja.json values were left as plain copies of the
 * English string (an untranslated label silently shipped as "translated"),
 * discovered only by manually diffing the two files value-by-value. This
 * test makes that class of bug fail CI instead of requiring another manual
 * diff.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Flattens a nested translation object into "dotted.path" -> string leaves. */
function flatten(obj: Json, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (typeof obj === "string") {
    out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      flatten(v as Json, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  // Every leaf in these files is a string today; keep flatten total (rather
  // than throwing) if a non-string leaf is ever added.
  return out;
}

const enFlat = flatten(en as Json);
const jaFlat = flatten(ja as Json);

/**
 * Keys where the ja value is CORRECTLY identical to en — not a missed
 * translation but a string with nothing language-specific in it: a product
 * name, a literal shell command / URL example / env-var-shaped label, an
 * empty string, a bare punctuation placeholder, or an interpolation string
 * built only from units/braces with no actual words. Everything else must
 * differ between locales.
 *
 * Do NOT add a key here to silence a failing test — write a real Japanese
 * translation instead. Only add a key if, like the ones below, there is
 * genuinely no word in the string to translate.
 */
const ALLOWED_IDENTICAL = new Set<string>([
  "header.title", // "shoal" — the product name, not translated in any locale
  "startModal.baseUrlPlaceholder", // "http://localhost:3000" — a URL example
  "startModal.llmBaseUrl", // "LLM Base URL" — an env-var-shaped technical label
  "duration.seconds", // "{{count}}s" — interpolation + unit, no words
  "duration.minutes", // "{{m}}m {{s}}s" — same as above, minutes+seconds shorthand
  "hall.traceCommand", // "npx playwright show-trace {{path}}" — a literal shell command
  "personas.accountRolePlaceholder", // "user / instructor / admin" — literal token examples
  "edge.empty", // "—" — a bare placeholder dash, not a word
  "table.actions", // "" — deliberately empty (table.actionsLabel carries the real a11y label)
]);

describe("i18n en/ja parity", () => {
  it("en.json と ja.json は同じキー集合を持つ", () => {
    expect(Object.keys(jaFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it("ja の値は許可リスト以外で en と一致してはいけない（未翻訳の混入を防ぐ）", () => {
    const untranslated = Object.keys(enFlat).filter(
      (key) => key in jaFlat && !ALLOWED_IDENTICAL.has(key) && jaFlat[key] === enFlat[key],
    );
    expect(untranslated, `these ja keys still hold the English string verbatim: ${untranslated.join(", ")}`).toEqual([]);
  });

  it("許可リストの各キーは実在し、今も en と ja が同じ値である（形骸化防止）", () => {
    for (const key of ALLOWED_IDENTICAL) {
      expect(enFlat[key], `allowlisted key "${key}" is missing from en.json`).toBeDefined();
      expect(jaFlat[key], `allowlisted key "${key}" is missing from ja.json`).toBe(enFlat[key]);
    }
  });
});
