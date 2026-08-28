import { describe, it, expect } from "vitest";
import { shouldSubmitOnEnter } from "../ime-enter";

function enterEvent(overrides: {
  isComposing?: boolean;
  keyCode?: number;
  key?: string;
} = {}) {
  return {
    key: overrides.key ?? "Enter",
    keyCode: overrides.keyCode ?? 13,
    nativeEvent: { isComposing: overrides.isComposing ?? false },
  };
}

describe("shouldSubmitOnEnter", () => {
  const idle = { composing: false, ignoreEnterAfterComposition: false };

  it("returns true for plain Enter", () => {
    expect(shouldSubmitOnEnter(enterEvent(), idle)).toBe(true);
  });

  it("returns false while composing", () => {
    expect(shouldSubmitOnEnter(enterEvent({ isComposing: true }), idle)).toBe(false);
    expect(shouldSubmitOnEnter(enterEvent(), { ...idle, composing: true })).toBe(false);
  });

  it("returns false immediately after compositionend", () => {
    expect(
      shouldSubmitOnEnter(enterEvent(), { composing: false, ignoreEnterAfterComposition: true }),
    ).toBe(false);
  });

  it("returns false for keyCode 229 (IME processing)", () => {
    expect(shouldSubmitOnEnter(enterEvent({ keyCode: 229 }), idle)).toBe(false);
  });

  it("returns false for non-Enter keys", () => {
    expect(shouldSubmitOnEnter(enterEvent({ key: "a" }), idle)).toBe(false);
  });
});
