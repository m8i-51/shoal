import { describe, it, expect } from "vitest";
import {
  resolveOutputLanguage,
  outputLanguageInstruction,
  withOutputLanguage,
} from "../language";

describe("resolveOutputLanguage", () => {
  it("SHOAL_LANG が未設定なら null（既定の挙動を変えない）", () => {
    expect(resolveOutputLanguage({})).toBeNull();
    expect(resolveOutputLanguage({ SHOAL_LANG: "" })).toBeNull();
    expect(resolveOutputLanguage({ SHOAL_LANG: "   " })).toBeNull();
  });

  it("既知のコードを言語名に解決する", () => {
    expect(resolveOutputLanguage({ SHOAL_LANG: "ja" })).toBe("Japanese");
    expect(resolveOutputLanguage({ SHOAL_LANG: "JA" })).toBe("Japanese");
    expect(resolveOutputLanguage({ SHOAL_LANG: "pt-BR" })).toBe("Brazilian Portuguese");
  });

  it("未知の値はそのまま通す", () => {
    expect(resolveOutputLanguage({ SHOAL_LANG: "Swiss German" })).toBe("Swiss German");
  });

  it("前後の空白を落とす", () => {
    expect(resolveOutputLanguage({ SHOAL_LANG: "  ja  " })).toBe("Japanese");
  });
});

describe("outputLanguageInstruction", () => {
  it("散文だけを対象にし、識別子は据え置くよう指示する", () => {
    const instruction = outputLanguageInstruction("Japanese");
    expect(instruction).toContain("Japanese");
    // Without this scoping a "reply with only the id" call would translate the id.
    expect(instruction).toContain("identifiers");
    expect(instruction).toContain("enum values");
  });
});

describe("withOutputLanguage", () => {
  it("未設定ならプロンプトを変えない", () => {
    expect(withOutputLanguage("You are a QA agent.", {})).toBe("You are a QA agent.");
  });

  it("設定時は元のプロンプトを保ったまま末尾に追記する", () => {
    const out = withOutputLanguage("You are a QA agent.", { SHOAL_LANG: "ja" });
    expect(out.startsWith("You are a QA agent.")).toBe(true);
    expect(out).toContain("Japanese");
  });
});
