/**
 * Wraps `@word` in backticks so LLM-written text can't ping a real GitHub user
 * or team by accident (or by an app it read prompting it to). Applies to every
 * string that reaches a tracker — issue bodies, regression reports, and
 * comments on existing issues, where a stray mention notifies every subscriber.
 * Skips anything already inside backticks, and anything preceded by a word
 * character — `user@example.com` stays intact rather than becoming
 * `user`@example`.com`.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/(^|[^\w`])@([\w-]+)/g, (_match, prefix: string, name: string) => `${prefix}\`@${name}\``);
}
