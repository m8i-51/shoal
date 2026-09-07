import { describe, it, expect } from "vitest";
import {
  SEVERITIES,
  formatSeverityLine,
  normalizeSeverity,
  severityLabel,
  severityRank,
  severitySchemaProperty,
} from "../severity";

describe("normalizeSeverity", () => {
  it("語彙そのものを受け付ける", () => {
    for (const s of SEVERITIES) expect(normalizeSeverity(s)).toBe(s);
  });

  it("大文字・空白・区切りを吸収する", () => {
    expect(normalizeSeverity("  CRITICAL ")).toBe("critical");
    expect(normalizeSeverity("Sev 0")).toBe("critical");
    expect(normalizeSeverity("sev-1")).toBe("major");
  });

  it("別語彙のエイリアスを受け付ける", () => {
    expect(normalizeSeverity("blocker")).toBe("critical");
    expect(normalizeSeverity("high")).toBe("major");
    expect(normalizeSeverity("sev1")).toBe("major");
    expect(normalizeSeverity("P2")).toBe("minor");
    expect(normalizeSeverity("medium")).toBe("minor");
    expect(normalizeSeverity("low")).toBe("trivial");
    expect(normalizeSeverity("nit")).toBe("trivial");
  });

  it("置けない値は既定値ではなく null にする", () => {
    // A fabricated severity is worse than a missing one — a team sorting by it
    // could not tell the two apart.
    expect(normalizeSeverity("catastrophic")).toBeNull();
    expect(normalizeSeverity(undefined)).toBeNull();
    expect(normalizeSeverity(3)).toBeNull();
    expect(normalizeSeverity(null)).toBeNull();
    expect(normalizeSeverity({})).toBeNull();
  });
});

describe("severityRank", () => {
  it("critical が最優先、未設定は最後", () => {
    expect(severityRank("critical")).toBe(0);
    expect(severityRank("trivial")).toBe(3);
    expect(severityRank(null)).toBe(4);
  });

  it("ランク順に並べ替えられる", () => {
    const sorted = ["trivial", "critical", null, "minor", "major"] as const;
    expect([...sorted].sort((a, b) => severityRank(a) - severityRank(b))).toEqual([
      "critical", "major", "minor", "trivial", null,
    ]);
  });
});

describe("severityLabel", () => {
  it("トラッカーで絞り込めるラベルを返す", () => {
    expect(severityLabel("critical")).toBe("severity:critical");
  });
});

describe("severitySchemaProperty", () => {
  it("語彙全体を enum として出し、修正コストではなく影響で判断させる", () => {
    const prop = severitySchemaProperty() as { enum: string[]; description: string };
    expect(prop.enum).toEqual([...SEVERITIES]);
    expect(prop.description).toContain("not from how hard it looks to fix");
    for (const s of SEVERITIES) expect(prop.description).toContain(s);
  });
});

describe("formatSeverityLine", () => {
  it("未設定なら何も出さない", () => {
    expect(formatSeverityLine(null)).toBe("");
  });

  it("設定時はレベルとその定義を出す", () => {
    const line = formatSeverityLine("major");
    expect(line).toContain("**Severity:** major");
    expect(line).toContain("workaround");
  });
});
