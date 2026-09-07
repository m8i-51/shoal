/**
 * language.ts — the language agents write their human-facing prose in.
 *
 * Every prompt in shoal is authored in English (a few in Japanese), and the
 * model answers in whatever language it infers from the prompt and the target
 * app. That makes the output language an accident of the page under test: the
 * same swarm files English issues against one app and Japanese ones against
 * another. `SHOAL_LANG` makes it a setting.
 *
 * The instruction is appended to the system prompt at the one place every
 * Messages-API call passes through (`createMessageWithRetry`) plus the Claude
 * CLI runner, rather than at each of the ~15 prompt-building sites, so a new
 * lane cannot forget it.
 */

/**
 * Common language codes to the name a model recognises. Anything not listed is
 * passed through verbatim, so `SHOAL_LANG="Brazilian Portuguese"` works without
 * needing an entry here.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  "pt-br": "Brazilian Portuguese",
  ru: "Russian",
  th: "Thai",
  tr: "Turkish",
  vi: "Vietnamese",
  zh: "Chinese",
  "zh-cn": "Simplified Chinese",
  "zh-tw": "Traditional Chinese",
};

/**
 * Resolve `SHOAL_LANG` to a language name, or null when unset.
 *
 * Unset means "leave it to the model", which is the behaviour every release
 * before this setting had — so an operator who never sets it sees no change.
 */
export function resolveOutputLanguage(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.SHOAL_LANG ?? "").trim();
  if (!raw) return null;
  return LANGUAGE_NAMES[raw.toLowerCase()] ?? raw;
}

/**
 * The sentence appended to a system prompt.
 *
 * Deliberately scoped to prose. Without the second half, a structured call
 * that says "reply with only the id" (tracker catalog matching, for one) would
 * translate the id and stop matching anything.
 */
export function outputLanguageInstruction(language: string): string {
  return (
    `\n\nWrite all prose you author for humans — finding titles and bodies, issue text, ` +
    `summaries, explanations — in ${language}. Leave verbatim anything that is not prose: ` +
    `identifiers, enum values, tool and field names, URLs, CSS selectors, code, JSON keys, ` +
    `and text you are quoting from the page under test.`
  );
}

/**
 * Append the instruction to a system prompt when `SHOAL_LANG` is set.
 * Returns the prompt unchanged when it is not.
 */
export function withOutputLanguage(system: string, env: NodeJS.ProcessEnv = process.env): string {
  const language = resolveOutputLanguage(env);
  if (!language) return system;
  return system + outputLanguageInstruction(language);
}
