import { describe, it, expect } from "vitest";
import request from "supertest";
import { createFormsBenchApp } from "../forms-app";

describe("forms bench app seeded bugs", () => {
  it("empty-email-accepted: 空 email の ticket が保存される", async () => {
    const app = createFormsBenchApp();
    const post = await request(app).post("/contact").type("form").send({ email: "", message: "Need help" });
    expect(post.status).toBe(302);
    const list = await request(app).get("/tickets");
    expect(list.text).toContain("Need help");
    expect(list.text).toContain("(empty)");
  });

  it("error-page-leak: /status が 500 で内部エラーを露出する", async () => {
    const res = await request(createFormsBenchApp()).get("/status");
    expect(res.status).toBe(500);
    expect(res.text).toContain("DATABASE_CONNECTION_FAILED");
    expect(res.text).toContain("Stack:");
  });

  it("missing-form-labels: contact フォームに label 要素がない", async () => {
    const res = await request(createFormsBenchApp()).get("/contact");
    expect(res.text).not.toMatch(/<label[^>]*>/i);
    expect(res.text).toContain('placeholder="Email"');
  });
});
