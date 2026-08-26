/**
 * トラッカー固有の close / resolution 情報を GitHub 互換の stateReason に正規化する。
 * adoption 集計は `not_planned` を rejected、それ以外の close を adopted として扱う。
 */

export interface CloseReasonInput {
  resolutionName?: string | null;
  statusName?: string | null;
  labels?: string[];
}

const REJECTED_PATTERN =
  /won'?t\s*(fix|do)|wontfix|not\s*planned|declined|rejected|duplicate|invalid|cancelled|canceled|不対応|却下|対応しない|見送/i;

/** GitHub 互換: "completed" | "not_planned" | null（判定不能） */
export function normalizeCloseReason(input: CloseReasonInput): string | null {
  const parts = [input.resolutionName, input.statusName, ...(input.labels ?? [])]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (parts.length === 0) return null;

  const combined = parts.join(" ");
  if (REJECTED_PATTERN.test(combined)) return "not_planned";
  return "completed";
}
