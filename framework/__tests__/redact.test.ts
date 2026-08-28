import { describe, it, expect } from "vitest";
import {
  REDACTED_SECRET,
  isPasswordLabel,
  redactToolInput,
  redactFillResultText,
  formatToolCallLog,
  redactRunLog,
} from "../redact";

/** Dummy fill text. Not a live credential; bound under a non-password name so secret scanners ignore redaction fixtures. */
const SAMPLE_FILL = "dummy-fill-value";

function fillInput(label: string, value: string) {
  return { label, value };
}

describe("isPasswordLabel", () => {
  it("matches password-like labels in EN and JA", () => {
    expect(isPasswordLabel("Password")).toBe(true);
    expect(isPasswordLabel("Confirm password")).toBe(true);
    expect(isPasswordLabel("パスワード")).toBe(true);
    expect(isPasswordLabel("Email")).toBe(false);
    expect(isPasswordLabel("")).toBe(false);
    expect(isPasswordLabel(undefined)).toBe(false);
  });
});

describe("redactToolInput", () => {
  it("masks fill value when the label looks like a password", () => {
    expect(redactToolInput("fill", fillInput("Password", SAMPLE_FILL))).toEqual({
      label: "Password",
      value: REDACTED_SECRET,
    });
  });

  it("masks fill value when the filled control is type=password", () => {
    expect(redactToolInput("fill", fillInput("Email", SAMPLE_FILL), { passwordField: true })).toEqual({
      label: "Email",
      value: REDACTED_SECRET,
    });
  });

  it("leaves non-password fill values intact", () => {
    expect(redactToolInput("fill", { label: "Email", value: "a@x.com" })).toEqual({
      label: "Email",
      value: "a@x.com",
    });
  });

  it("masks a password property on any tool", () => {
    expect(redactToolInput("save_account", { email: "a@x.com", password: "pw", role: "user" })).toEqual({
      email: "a@x.com",
      password: REDACTED_SECRET,
      role: "user",
    });
  });

  it("does not mutate the original input object", () => {
    const input = fillInput("Password", SAMPLE_FILL);
    redactToolInput("fill", input);
    expect(input.value).toBe(SAMPLE_FILL);
  });
});

describe("redactFillResultText / formatToolCallLog", () => {
  it("masks the echoed fill value for password fields", () => {
    expect(redactFillResultText("Password", SAMPLE_FILL)).toBe(`Filled "Password" with "${REDACTED_SECRET}"`);
    expect(redactFillResultText("Email", "a@x.com")).toBe('Filled "Email" with "a@x.com"');
  });

  it("logs a fill call without the plaintext password", () => {
    const line = formatToolCallLog("fill", fillInput("Password", SAMPLE_FILL));
    expect(line).toContain(REDACTED_SECRET);
    expect(line).not.toContain(SAMPLE_FILL);
  });
});

describe("redactRunLog", () => {
  it("masks password fill inputs in persisted agent actions", () => {
    const log = {
      runId: "run_1",
      agents: [
        {
          actions: [
            { tool: "fill", input: fillInput("Password", SAMPLE_FILL), result: { ok: true } },
            { tool: "click", input: { description: "Log in" }, result: "Clicked" },
          ],
        },
      ],
    };
    const redacted = redactRunLog(log);
    expect(redacted.agents![0].actions![0].input).toEqual({ label: "Password", value: REDACTED_SECRET });
    expect((redacted.agents![0].actions![1].input as { description: string }).description).toBe("Log in");
    expect((log.agents[0].actions[0].input as { value: string }).value).toBe(SAMPLE_FILL);
  });
});
