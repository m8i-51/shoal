import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { CATEGORY_COLOR } from "../format";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function contrastWithWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return 1.05 / (luminance + 0.05);
}

describe("CATEGORY_COLOR", () => {
  it("bug/ux/feature-request/goal-gap の4カテゴリを持つ", () => {
    expect(Object.keys(CATEGORY_COLOR).sort()).toEqual(["bug", "feature-request", "goal-gap", "ux"]);
  });

  it("すべての色は白文字に対して WCAG AA (>=4.5:1) を満たす", () => {
    for (const [category, color] of Object.entries(CATEGORY_COLOR)) {
      expect(contrastWithWhite(color), `${category} (${color}) against #fff`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Hall.tsx はカテゴリ配色を重複定義しない（CATEGORY_COLOR を import して使う）", () => {
  const hallSource = fs.readFileSync(path.join(__dirname, "..", "..", "pages", "Hall.tsx"), "utf-8");

  it("../utils/format から CATEGORY_COLOR を import している", () => {
    expect(hallSource).toMatch(/import\s*\{\s*CATEGORY_COLOR\s*\}\s*from\s*["']..\/utils\/format["']/);
  });

  it("独自の CAT_COLOR / カテゴリ配色マップを再定義していない", () => {
    expect(hallSource).not.toMatch(/CAT_COLOR\s*[:=]/);
    // フォールバック色は Hall 独自の挙動として維持される
    expect(hallSource).toContain('CATEGORY_COLOR[finding.category] ?? "#6b7280"');
  });
});
