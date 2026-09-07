import { describe, it, expect } from "vitest";
import { checkUrlSafety, type LookupFn } from "../safe-fetch";

function fakeLookup(address: string, family = 4): LookupFn {
  return async () => ({ address, family });
}

describe("checkUrlSafety — scheme", () => {
  it("http / https は許可される（パブリックアドレス）", async () => {
    await expect(checkUrlSafety("http://93.184.216.34/")).resolves.toEqual({ ok: true });
    await expect(checkUrlSafety("https://93.184.216.34/")).resolves.toEqual({ ok: true });
  });

  it("file: など http/https 以外のスキームは拒否する", async () => {
    const result = await checkUrlSafety("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("scheme");
  });

  it("不正な URL はエラーではなく拒否結果を返す", async () => {
    const result = await checkUrlSafety("not a url");
    expect(result.ok).toBe(false);
  });
});

describe("checkUrlSafety — literal IPv4 ranges", () => {
  const blocked = [
    "127.0.0.1", // loopback
    "127.255.255.255",
    "169.254.169.254", // link-local / cloud metadata
    "10.0.0.1", // private
    "172.16.0.1", // private
    "172.31.255.255", // private (upper bound of /12)
    "192.168.1.1", // private
    "0.0.0.0", // unspecified
  ];
  it.each(blocked)("%s は拒否する", async (ip) => {
    const result = await checkUrlSafety(`http://${ip}/`);
    expect(result.ok).toBe(false);
  });

  it("172.15.255.255 と 172.32.0.0 は private レンジの境界外なので許可する", async () => {
    await expect(checkUrlSafety("http://172.15.255.255/")).resolves.toEqual({ ok: true });
    await expect(checkUrlSafety("http://172.32.0.0/")).resolves.toEqual({ ok: true });
  });
});

describe("checkUrlSafety — literal IPv6 ranges", () => {
  it("::1 (loopback) は拒否する", async () => {
    const result = await checkUrlSafety("http://[::1]/");
    expect(result.ok).toBe(false);
  });

  it(":: (unspecified) は拒否する", async () => {
    const result = await checkUrlSafety("http://[::]/");
    expect(result.ok).toBe(false);
  });

  it("fe80::/10 (link-local) は拒否する", async () => {
    const result = await checkUrlSafety("http://[fe80::1]/");
    expect(result.ok).toBe(false);
  });

  it("fc00::/7 (unique local) は拒否する", async () => {
    await expect((await checkUrlSafety("http://[fc00::1]/")).ok).toBe(false);
    await expect((await checkUrlSafety("http://[fdff:ffff::1]/")).ok).toBe(false);
  });

  it("グローバルな IPv6 アドレスは許可する", async () => {
    const result = await checkUrlSafety("http://[2001:4860:4860::8888]/");
    expect(result).toEqual({ ok: true });
  });
});

describe("checkUrlSafety — IPv4-mapped IPv6", () => {
  it("::ffff:127.0.0.1（ドット表記）は IPv4 のループバックとして拒否する", async () => {
    const result = await checkUrlSafety("http://[::ffff:127.0.0.1]/");
    expect(result.ok).toBe(false);
  });

  it("::ffff:169.254.169.254（クラウドメタデータ）は拒否する", async () => {
    const result = await checkUrlSafety("http://[::ffff:169.254.169.254]/");
    expect(result.ok).toBe(false);
  });

  it("URL パーサが正規化する圧縮16進表記（::ffff:7f00:1 = 127.0.0.1）も拒否する", async () => {
    // new URL("http://[::ffff:127.0.0.1]/").hostname normalizes to "[::ffff:7f00:1]" —
    // this exercises that exact shape rather than assuming the dotted form survives.
    const result = await checkUrlSafety("http://[::ffff:7f00:1]/");
    expect(result.ok).toBe(false);
  });

  it("マップされていないグローバル IPv4 は許可する", async () => {
    const result = await checkUrlSafety("http://[::ffff:93.184.216.34]/");
    expect(result).toEqual({ ok: true });
  });
});

describe("checkUrlSafety — hostname resolution", () => {
  it("プライベート IP に解決されるホスト名は拒否する（DNS rebinding 対策の要）", async () => {
    const result = await checkUrlSafety("http://evil.example/", { lookup: fakeLookup("127.0.0.1") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("evil.example");
  });

  it("クラウドメタデータアドレスに解決されるホスト名も拒否する", async () => {
    const result = await checkUrlSafety("http://metadata.internal/", { lookup: fakeLookup("169.254.169.254") });
    expect(result.ok).toBe(false);
  });

  it("パブリック IP に解決されるホスト名は許可する", async () => {
    const result = await checkUrlSafety("https://example.com/readme", { lookup: fakeLookup("93.184.216.34") });
    expect(result).toEqual({ ok: true });
  });

  it("名前解決に失敗した場合は拒否結果を返す（例外を投げない）", async () => {
    const result = await checkUrlSafety("http://nonexistent.invalid/", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("nonexistent.invalid");
  });

  it("リテラル IP のホストは lookup を呼ばない", async () => {
    let called = false;
    await checkUrlSafety("http://93.184.216.34/", {
      lookup: async () => {
        called = true;
        return { address: "127.0.0.1", family: 4 };
      },
    });
    expect(called).toBe(false);
  });
});

describe("checkUrlSafety — allowedOrigin exception", () => {
  it("BASE_URL と同一オリジンなら localhost でも許可する", async () => {
    const result = await checkUrlSafety("http://localhost:3000/about", { allowedOrigin: "http://localhost:3000" });
    expect(result).toEqual({ ok: true });
  });

  it("BASE_URL と同一オリジンなら lookup を呼ばずに許可する", async () => {
    let called = false;
    const result = await checkUrlSafety("http://localhost:3000/", {
      allowedOrigin: "http://localhost:3000",
      lookup: async () => {
        called = true;
        return { address: "127.0.0.1", family: 4 };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(called).toBe(false);
  });

  it("ポートが違えば同一オリジンではないので通常のブロックが働く", async () => {
    const result = await checkUrlSafety("http://localhost:4000/", { allowedOrigin: "http://localhost:3000" });
    expect(result.ok).toBe(false);
  });

  it("スキームが違えば同一オリジンではない", async () => {
    const result = await checkUrlSafety("https://localhost:3000/", { allowedOrigin: "http://localhost:3000" });
    expect(result.ok).toBe(false);
  });

  it("他の内部ホストは allowedOrigin と一致しない限り拒否される", async () => {
    const result = await checkUrlSafety("http://127.0.0.1:9999/", { allowedOrigin: "http://localhost:3000" });
    expect(result.ok).toBe(false);
  });
});
