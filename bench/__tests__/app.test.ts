import { describe, it, expect } from "vitest";
import request from "supertest";
import { createBenchApp } from "../app";

/**
 * ベンチアプリの「仕込んだバグ」が存在し続けることを固定するテスト。
 * ここが落ちた = 誰かが正解バグを直してしまった、ということ。
 */
describe("bench app seeded bugs", () => {
  it("admin-unprotected: /admin が認証なしで 200 を返す", async () => {
    const res = await request(createBenchApp()).get("/admin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Reset all inventory");
  });

  it("cart-total-wrong: 合計が数量を無視している", async () => {
    const res = await request(createBenchApp()).get("/cart");
    // 正しい合計は 500*2+3200*1+280*3 = 5040 だが、仕込みバグでは 500+3200+280 = 3980
    expect(res.text).toContain("Total: ¥3980");
    expect(res.text).not.toContain("Total: ¥5040");
  });

  it("silent-save-failure: 20 文字超の名前は保存されないが成功したように見える", async () => {
    const app = createBenchApp();
    const longName = "An Extremely Long Product Name";
    const post = await request(app).post("/items").type("form").send({ name: longName, price: "100", quantity: "1" });
    expect(post.status).toBe(302); // 成功したかのようにリダイレクト
    const list = await request(app).get("/items");
    expect(list.text).not.toContain(longName); // だが保存されていない
  });

  it("短い名前は普通に保存される（アプリ自体は動作する）", async () => {
    const app = createBenchApp();
    await request(app).post("/items").type("form").send({ name: "Eraser", price: "150", quantity: "2" });
    const list = await request(app).get("/items");
    expect(list.text).toContain("Eraser");
  });

  it("missing-alt-text: ホームの画像に alt がない", async () => {
    const res = await request(createBenchApp()).get("/");
    expect(res.text).toMatch(/<img(?![^>]*alt=)[^>]*>/);
  });

  it("delete-no-confirm: 削除フォームに確認機構がなく即削除される", async () => {
    const app = createBenchApp();
    const before = await request(app).get("/items");
    expect(before.text).toContain("Blue Notebook");
    expect(before.text).not.toMatch(/confirm/i);
    await request(app).post("/items/1/delete");
    const after = await request(app).get("/items");
    expect(after.text).not.toContain("Blue Notebook");
  });

  it("broken-help-link: ナビに Help リンクがあるが /help は 404", async () => {
    const app = createBenchApp();
    const home = await request(app).get("/");
    expect(home.text).toContain('href="/help"');
    const help = await request(app).get("/help");
    expect(help.status).toBe(404);
  });
});
