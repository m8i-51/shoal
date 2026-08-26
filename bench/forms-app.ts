/**
 * shoal-bench forms variant — フォーム / エラー処理系の仕込みバグ。
 *
 * labels-forms.json と 1:1 対応:
 * - empty-email-accepted: 必須の email がサーバー側で検証されない
 * - error-page-leak: エラーページが内部情報を露出する
 * - missing-form-labels: 入力に label がなく placeholder のみ（a11y）
 */
import express from "express";

interface Ticket {
  id: number;
  email: string;
  message: string;
}

export function createFormsBenchApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  let nextId = 1;
  const tickets: Ticket[] = [];

  const page = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} — bench forms</title>
<style>
  body{font-family:sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#222}
  nav a{margin-right:1rem}
  input,textarea{display:block;width:100%;margin:.35rem 0 .75rem;padding:.45rem}
  button{background:#2563eb;color:#fff;border:none;padding:.55rem 1rem;border-radius:4px;cursor:pointer}
</style></head>
<body>
<nav><a href="/">Home</a><a href="/contact">Contact</a><a href="/tickets">Tickets</a><a href="/status">Status</a></nav>
<h1>${title}</h1>
${body}
</body></html>`;

  app.get("/", (_req, res) => {
    res.send(page("bench forms", `
<p>Submit support tickets and check system status.</p>
<p><a href="/contact">Open contact form</a></p>`));
  });

  app.get("/contact", (_req, res) => {
    res.send(page("Contact", `
<form method="post" action="/contact">
<input name="email" type="email" required placeholder="Email">
<textarea name="message" required placeholder="Message"></textarea>
<button type="submit">Send ticket</button>
</form>`));
  });

  app.post("/contact", (req, res) => {
    const email = String(req.body.email ?? "");
    const message = String(req.body.message ?? "");
    // empty-email-accepted (seeded bug): HTML では required だがサーバーは空 email を受理する
    tickets.push({ id: nextId++, email, message });
    res.redirect("/tickets");
  });

  app.get("/tickets", (_req, res) => {
    const rows = tickets.map((t) => `<tr><td>${t.id}</td><td>${t.email || "(empty)"}</td><td>${t.message}</td></tr>`).join("\n");
    res.send(page("Tickets", `
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
<thead><tr><th>ID</th><th>Email</th><th>Message</th></tr></thead>
<tbody>${rows || "<tr><td colspan='3'>No tickets yet</td></tr>"}</tbody>
</table>`));
  });

  // error-page-leak (seeded bug): 内部エラー詳細をそのまま HTML に返す
  app.get("/status", (_req, res) => {
    res.status(500).send(page("Status", `
<p>System status unavailable.</p>
<pre>Error: DATABASE_CONNECTION_FAILED at db/connect.ts:42
Stack: FormsService.checkHealth -&gt; PostgresPool.query</pre>`));
  });

  return app;
}

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("forms-app.ts")) {
  const port = parseInt(process.env.BENCH_PORT ?? "4320", 10);
  createFormsBenchApp().listen(port, () => console.log(`[bench] forms app → http://localhost:${port}`));
}
