import { describe, it, expect } from "vitest";
import { isRetryableLLMError, parseRetryAfterMs } from "../llm-retry";

describe("isRetryableLLMError", () => {
  it.each([429, 500, 502, 503, 504, 529])("status %i はリトライ対象", (status) => {
    expect(isRetryableLLMError({ status })).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("status %i はリトライ対象ではない（クライアントエラー）", (status) => {
    expect(isRetryableLLMError({ status })).toBe(false);
  });

  it("APIConnectionError（ネットワーク到達不能、status なし）はリトライ対象", () => {
    expect(isRetryableLLMError({ name: "APIConnectionError" })).toBe(true);
  });

  it("APIConnectionTimeoutError もリトライ対象", () => {
    expect(isRetryableLLMError({ name: "APIConnectionTimeoutError" })).toBe(true);
  });

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"])(
    "ネットワークエラーコード %s はリトライ対象",
    (code) => {
      expect(isRetryableLLMError({ code })).toBe(true);
    },
  );

  it("undici が cause の下に code をネストしていてもリトライ対象と判定する", () => {
    expect(isRetryableLLMError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })).toBe(true);
  });

  it("status も既知の name/code も無ければリトライ対象ではない", () => {
    expect(isRetryableLLMError(new Error("something else"))).toBe(false);
    expect(isRetryableLLMError({ code: "SOME_UNKNOWN_CODE" })).toBe(false);
    expect(isRetryableLLMError(null)).toBe(false);
    expect(isRetryableLLMError(undefined)).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("秒数形式をミリ秒に変換する", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("HTTP-date 形式（RFC 7231）を正しくミリ秒に変換する — 以前は parseInt が NaN を返し即時リトライになっていた", () => {
    const future = new Date(Date.now() + 5000);
    const ms = parseRetryAfterMs(future.toUTCString());
    expect(ms).not.toBeNull();
    // 呼び出し間の実行時間ぶんの誤差を許容する
    expect(ms!).toBeGreaterThan(4000);
    expect(ms!).toBeLessThanOrEqual(5000);
  });

  it("過去の日付は 0 に丸める（マイナス待機にしない）", () => {
    const past = new Date(Date.now() - 5000);
    expect(parseRetryAfterMs(past.toUTCString())).toBe(0);
  });

  it("null / undefined / 空文字は null を返す", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
  });

  it("数値でも日付でもない値は null を返す（NaN 待機を防ぐ）", () => {
    expect(parseRetryAfterMs("not-a-valid-value-at-all")).toBeNull();
  });
});
