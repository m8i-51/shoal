import { describe, it, expect } from "vitest";
import { buildSafeProxyUrl } from "../proxy-url.js";

describe("buildSafeProxyUrl", () => {
  it("GitHub raw URL を許可ホスト上で再構築する", () => {
    expect(buildSafeProxyUrl("https://raw.githubusercontent.com/owner/repo/main/findings.json"))
      .toBe("https://raw.githubusercontent.com/owner/repo/main/findings.json");
  });

  it("gist raw URL を許可する", () => {
    expect(buildSafeProxyUrl("https://gist.githubusercontent.com/user/id/raw/file.json"))
      .toBe("https://gist.githubusercontent.com/user/id/raw/file.json");
  });

  it("query string を保持する", () => {
    expect(buildSafeProxyUrl("https://raw.githubusercontent.com/o/r/main/f.json?token=abc"))
      .toBe("https://raw.githubusercontent.com/o/r/main/f.json?token=abc");
  });

  it("http は拒否する", () => {
    expect(buildSafeProxyUrl("http://raw.githubusercontent.com/o/r/main/f.json")).toBeNull();
  });

  it("許可ホスト以外は拒否する", () => {
    expect(buildSafeProxyUrl("https://example.com/data.json")).toBeNull();
    expect(buildSafeProxyUrl("https://evil.com/data.json")).toBeNull();
    expect(buildSafeProxyUrl("https://raw.githubusercontent.com.evil.com/f.json")).toBeNull();
  });

  it("プライベートアドレスは拒否する", () => {
    expect(buildSafeProxyUrl("http://localhost/data.json")).toBeNull();
    expect(buildSafeProxyUrl("http://127.0.0.1/data.json")).toBeNull();
    expect(buildSafeProxyUrl("http://[::1]/data.json")).toBeNull();
    expect(buildSafeProxyUrl("http://192.168.1.1/data.json")).toBeNull();
    expect(buildSafeProxyUrl("http://10.0.0.1/data.json")).toBeNull();
    expect(buildSafeProxyUrl("https://169.254.169.254/latest/meta-data/")).toBeNull();
  });

  it("userinfo 付き URL は拒否する", () => {
    expect(buildSafeProxyUrl("https://raw.githubusercontent.com@evil.com/f.json")).toBeNull();
    expect(buildSafeProxyUrl("https://user:pass@raw.githubusercontent.com/o/r/f.json")).toBeNull();
  });

  it("非デフォルトポートは拒否する", () => {
    expect(buildSafeProxyUrl("https://raw.githubusercontent.com:8443/o/r/f.json")).toBeNull();
  });

  it("不正な文字列は拒否する", () => {
    expect(buildSafeProxyUrl("not a url")).toBeNull();
    expect(buildSafeProxyUrl("file:///etc/passwd")).toBeNull();
    expect(buildSafeProxyUrl("javascript:alert(1)")).toBeNull();
  });

  it("パスに絶対 URL を入れてもホストは変わらない", () => {
    const href = buildSafeProxyUrl("https://raw.githubusercontent.com/https://evil.com/f.json");
    expect(href).toBe("https://raw.githubusercontent.com/https://evil.com/f.json");
    expect(new URL(href!).hostname).toBe("raw.githubusercontent.com");
  });
});
