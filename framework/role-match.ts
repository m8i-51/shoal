/**
 * ペルソナ role とテストアカウント / シナリオ actor の role を突き合わせる。
 */

export function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function roleAffinity(a: string, b: string): number {
  const na = normalizeRole(a);
  const nb = normalizeRole(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;

  const tokensA = na.split(" ").filter(Boolean);
  const tokensB = nb.split(" ").filter(Boolean);

  // 一方が他方のトークンそのもの: "math instructor" × "instructor"
  if (tokensA.includes(nb) || tokensB.includes(na)) return 80;

  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];
  if (shorter.length > 0 && shorter.every((t) => longer.includes(t))) return 60;

  // スペースの無い複合語（日本語の「数学講師」×「講師」など）や administrator × admin
  if (na.includes(nb) || nb.includes(na)) return 40;

  const shared = tokensA.filter((t) => t.length >= 3 && tokensB.includes(t));
  if (shared.length > 0) return 20 + shared.join("").length;

  return 0;
}

export function findBestByRole<T extends { role: string }>(items: T[], role: string): T | undefined {
  let best: T | undefined;
  let bestScore = 0;
  for (const item of items) {
    const score = roleAffinity(item.role, role);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}
