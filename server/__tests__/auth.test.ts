import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  SESSION_COOKIE,
  assertBindingAllowed,
  hostGuard,
  isLoopbackHost,
  issueSessionCookie,
  requireToken,
  resolveBinding,
  resolveDashboardToken,
  type Binding,
} from "../auth";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

describe("isLoopbackHost", () => {
  it("ループバックを認識する", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.53", "LOCALHOST"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("外部到達可能なホストはループバックではない", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "10.0.0.1", "example.com", "::"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("resolveBinding", () => {
  it("既定はループバック:4000（以前の全インターフェース bind ではない）", () => {
    expect(resolveBinding(env({}))).toEqual({ host: "127.0.0.1", port: 4000, isLoopback: true });
  });

  it("SHOAL_HOST / PORT を反映する", () => {
    expect(resolveBinding(env({ SHOAL_HOST: "0.0.0.0", PORT: "8080" }))).toEqual({
      host: "0.0.0.0",
      port: 8080,
      isLoopback: false,
    });
  });

  it("不正な PORT は 4000 に倒す", () => {
    expect(resolveBinding(env({ PORT: "not-a-port" })).port).toBe(4000);
    expect(resolveBinding(env({ PORT: "70000" })).port).toBe(4000);
  });
});

describe("assertBindingAllowed", () => {
  const loopback: Binding = { host: "127.0.0.1", port: 4000, isLoopback: true };
  const exposed: Binding = { host: "0.0.0.0", port: 4000, isLoopback: false };

  it("ループバック既定は常に許可（オプトイン不要）", () => {
    expect(() => assertBindingAllowed(loopback, env({}))).not.toThrow();
  });

  it("非ループバックはオプトインが無ければ拒否する（平文 HTTP のため）", () => {
    expect(() => assertBindingAllowed(exposed, env({}))).toThrow(/refusing to bind/);
  });

  it("拒否メッセージは次にすべきことを示す", () => {
    let message = "";
    try {
      assertBindingAllowed(exposed, env({}));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("reverse proxy");
    expect(message).toContain("ssh -L");
    expect(message).toContain("SHOAL_ALLOW_INSECURE=1");
  });

  it("SHOAL_ALLOW_INSECURE=1 で明示的に許可できる", () => {
    expect(() => assertBindingAllowed(exposed, env({ SHOAL_ALLOW_INSECURE: "1" }))).not.toThrow();
  });

  it("1 以外の値では許可しない（曖昧な真偽値を受け付けない）", () => {
    for (const value of ["true", "yes", "0", ""]) {
      expect(() => assertBindingAllowed(exposed, env({ SHOAL_ALLOW_INSECURE: value }))).toThrow();
    }
  });
});

describe("resolveDashboardToken", () => {
  const loopback: Binding = { host: "127.0.0.1", port: 4000, isLoopback: true };
  const exposed: Binding = { host: "0.0.0.0", port: 4000, isLoopback: false };

  it("ループバック既定ではトークンを要求しない", () => {
    const decision = resolveDashboardToken(loopback, env({}));
    expect(decision.token).toBeNull();
    expect(decision.generated).toBe(false);
  });

  it("外部公開時はトークンを必須にし、無ければ生成する", () => {
    const decision = resolveDashboardToken(exposed, env({}));
    expect(decision.token).toBeTruthy();
    expect(decision.generated).toBe(true);
    expect(decision.token!.length).toBeGreaterThanOrEqual(32);
    expect(decision.notices.join("\n")).toContain(decision.token!);
  });

  it("生成トークンは毎回異なる", () => {
    const a = resolveDashboardToken(exposed, env({}));
    const b = resolveDashboardToken(exposed, env({}));
    expect(a.token).not.toBe(b.token);
  });

  it("SHOAL_TOKEN があればそれを使う（ループバックでも有効化される）", () => {
    const decision = resolveDashboardToken(loopback, env({ SHOAL_TOKEN: "a".repeat(20) }));
    expect(decision.token).toBe("a".repeat(20));
    expect(decision.generated).toBe(false);
  });

  it("短すぎる SHOAL_TOKEN は黙って受け入れず失敗させる", () => {
    expect(() => resolveDashboardToken(exposed, env({ SHOAL_TOKEN: "short" }))).toThrow(/too short/);
  });
});

function appWithToken(token: string | null) {
  const app = express();
  app.use("/api", requireToken(token));
  app.get("/api/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("requireToken", () => {
  it("トークン未設定なら素通しする", async () => {
    await request(appWithToken(null)).get("/api/ping").expect(200);
  });

  it("トークン設定時、無提示は 401", async () => {
    await request(appWithToken("s3cret-token-value")).get("/api/ping").expect(401);
  });

  it("Authorization: Bearer を受け付ける", async () => {
    await request(appWithToken("s3cret-token-value"))
      .get("/api/ping")
      .set("Authorization", "Bearer s3cret-token-value")
      .expect(200);
  });

  it("X-Shoal-Token ヘッダを受け付ける", async () => {
    await request(appWithToken("s3cret-token-value"))
      .get("/api/ping")
      .set("X-Shoal-Token", "s3cret-token-value")
      .expect(200);
  });

  it("EventSource 用に ?token= も受け付ける", async () => {
    await request(appWithToken("s3cret-token-value"))
      .get("/api/ping?token=s3cret-token-value")
      .expect(200);
  });

  it("誤ったトークンは 401", async () => {
    await request(appWithToken("s3cret-token-value"))
      .get("/api/ping")
      .set("X-Shoal-Token", "wrong-token-value")
      .expect(401);
  });

  it("長さが違うトークンでも 401（比較で落ちない）", async () => {
    await request(appWithToken("s3cret-token-value")).get("/api/ping?token=x").expect(401);
  });

  it("/api 以外は認証対象外（UI バンドルを読めるように）", async () => {
    await request(appWithToken("s3cret-token-value")).get("/health").expect(200);
  });
});

function appWithSession(token: string | null) {
  const app = express();
  app.use(issueSessionCookie(token));
  app.use("/api", requireToken(token));
  app.get("/", (_req, res) => {
    res.send("dashboard");
  });
  app.get("/api/ping", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("issueSessionCookie", () => {
  const TOKEN = "s3cret-token-value";

  it("正しい ?token= を HttpOnly cookie に交換する", async () => {
    const res = await request(appWithSession(TOKEN)).get("/?token=" + TOKEN).expect(200);
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("平文 HTTP では Secure を付けない（cookie が落ちて締め出されるため）", async () => {
    const res = await request(appWithSession(TOKEN)).get("/?token=" + TOKEN);
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("Secure");
  });

  it("TLS 終端の背後では Secure を付ける", async () => {
    const res = await request(appWithSession(TOKEN))
      .get("/?token=" + TOKEN)
      .set("X-Forwarded-Proto", "https");
    expect(String(res.headers["set-cookie"] ?? "")).toContain("Secure");
  });

  it("誤った ?token= では cookie を発行しない", async () => {
    const res = await request(appWithSession(TOKEN)).get("/?token=wrong-token-value");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("トークン不要の構成では cookie を発行しない", async () => {
    const res = await request(appWithSession(null)).get("/?token=anything");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("交換後は cookie だけで API を叩ける（URL にトークンが要らない）", async () => {
    await request(appWithSession(TOKEN))
      .get("/api/ping")
      .set("Cookie", `${SESSION_COOKIE}=${TOKEN}`)
      .expect(200);
  });

  it("誤った cookie は 401", async () => {
    await request(appWithSession(TOKEN))
      .get("/api/ping")
      .set("Cookie", `${SESSION_COOKIE}=wrong-token-value`)
      .expect(401);
  });

  it("他の cookie が混ざっていても読み取れる", async () => {
    await request(appWithSession(TOKEN))
      .get("/api/ping")
      .set("Cookie", `theme=dark; ${SESSION_COOKIE}=${TOKEN}; other=1`)
      .expect(200);
  });

  it("壊れた cookie ヘッダでも落ちない", async () => {
    await request(appWithSession(TOKEN))
      .get("/api/ping")
      .set("Cookie", "novalue; =empty; %ZZ=bad")
      .expect(401);
  });
});

function appWithHostGuard(binding: Binding) {
  const app = express();
  app.use(hostGuard(binding));
  app.get("/api/ping", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const loopbackBinding: Binding = { host: "127.0.0.1", port: 4000, isLoopback: true };

describe("hostGuard", () => {
  it("ループバックの Host は通す", async () => {
    await request(appWithHostGuard(loopbackBinding))
      .get("/api/ping")
      .set("Host", "localhost:4000")
      .expect(200);
  });

  it("外部ホスト名の Host は拒否する（DNS リバインディング対策）", async () => {
    await request(appWithHostGuard(loopbackBinding))
      .get("/api/ping")
      .set("Host", "evil.example.com")
      .expect(403);
  });

  it("設定した SHOAL_HOST の Host は通す", async () => {
    const binding: Binding = { host: "shoal.internal", port: 4000, isLoopback: false };
    await request(appWithHostGuard(binding))
      .get("/api/ping")
      .set("Host", "shoal.internal:4000")
      .expect(200);
  });

  it("0.0.0.0 bind ならどの Host も受ける", async () => {
    const binding: Binding = { host: "0.0.0.0", port: 4000, isLoopback: false };
    await request(appWithHostGuard(binding))
      .get("/api/ping")
      .set("Host", "shoal.internal:4000")
      .expect(200);
  });

  it("別オリジンからのリクエストは拒否する", async () => {
    await request(appWithHostGuard(loopbackBinding))
      .get("/api/ping")
      .set("Host", "localhost:4000")
      .set("Origin", "https://evil.example.com")
      .expect(403);
  });

  it("ループバック bind なら別ポートのループバック origin も通す（vite dev proxy）", async () => {
    await request(appWithHostGuard(loopbackBinding))
      .get("/api/ping")
      .set("Host", "localhost:5173")
      .set("Origin", "http://localhost:5173")
      .expect(200);
  });

  it("外部公開 bind では別ポートのループバック origin を通さない", async () => {
    const binding: Binding = { host: "0.0.0.0", port: 4000, isLoopback: false };
    await request(appWithHostGuard(binding))
      .get("/api/ping")
      .set("Host", "shoal.internal:4000")
      .set("Origin", "http://localhost:5173")
      .expect(403);
  });

  it("同一オリジンからのリクエストは通す", async () => {
    await request(appWithHostGuard(loopbackBinding))
      .get("/api/ping")
      .set("Host", "localhost:4000")
      .set("Origin", "http://localhost:4000")
      .expect(200);
  });

  it("壊れた Origin は拒否する", async () => {
    await request(appWithHostGuard(loopbackBinding))
      .get("/api/ping")
      .set("Host", "localhost:4000")
      .set("Origin", "not a url")
      .expect(403);
  });
});
