/**
 * shoal-bench sample app — 意図的にバグを仕込んだ小さなストアアプリ。
 *
 * ここにあるバグは shoal の検出力を測るための「正解」であり、修正してはいけない。
 * 各バグは bench/labels.json のラベルと 1:1 に対応する:
 *
 * - admin-unprotected:   /admin が認証なしで開ける
 * - cart-total-wrong:    /cart の合計が数量を無視して計算される
 * - silent-save-failure: 20 文字を超える名前の商品は保存されないが成功したように見える
 * - missing-alt-text:    商品画像に alt がない
 * - low-contrast:        Buy ボタンが背景とほぼ同色で読めない
 * - delete-no-confirm:   削除が確認なしで即実行され、undo もない
 * - broken-help-link:    ナビの Help リンクが 404
 */
import express from "express";

interface Item {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

export function createBenchApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  let nextId = 4;
  const items: Item[] = [
    { id: 1, name: "Blue Notebook", price: 500, quantity: 2 },
    { id: 2, name: "Fountain Pen", price: 3200, quantity: 1 },
    { id: 3, name: "Sticky Notes", price: 280, quantity: 3 },
  ];

  // 注意: 仕込みバグの説明を HTML/CSS コメントとして配信しないこと。
  // エージェントがソースから答えを読めてしまい、ベンチマークが無意味になる。
  // .buy の low-contrast、img の missing-alt、delete の no-confirm は
  // ファイル冒頭のラベル対応表を参照。
  const page = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} — bench store</title>
<style>
  body{font-family:sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#222}
  nav a{margin-right:1rem}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
  .buy{background:#f4f4f4;color:#e0e0e0;border:1px solid #eee;padding:.5rem 1rem;border-radius:4px}
  .delete{background:#c00;color:#fff;border:none;padding:.3rem .7rem;border-radius:4px;cursor:pointer}
</style></head>
<body>
<nav><a href="/">Home</a><a href="/items">Items</a><a href="/cart">Cart</a><a href="/admin">Admin</a><a href="/help">Help</a></nav>
<h1>${title}</h1>
${body}
</body></html>`;

  app.get("/", (_req, res) => {
    res.send(page("bench store", `
<p>A tiny store for testing. Browse items, manage your cart.</p>
<img src="/logo.png" width="120" height="60">
<p><button class="buy">Buy featured item</button></p>`));
  });

  app.get("/logo.png", (_req, res) => {
    // 1x1 transparent PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    res.type("png").send(png);
  });

  app.get("/items", (_req, res) => {
    const rows = items.map((i) => `<tr>
<td>${i.name}</td><td>¥${i.price}</td><td>${i.quantity}</td>
<td><form method="post" action="/items/${i.id}/delete" style="display:inline"><button class="delete">Delete</button></form></td>
</tr>`).join("\n");
    res.send(page("Items", `
<table><thead><tr><th>Name</th><th>Price</th><th>Qty</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<h2>Add item</h2>
<form method="post" action="/items">
<label>Name <input name="name" required></label>
<label>Price <input name="price" type="number" value="100"></label>
<label>Qty <input name="quantity" type="number" value="1"></label>
<button type="submit">Add</button>
</form>`));
  });

  app.post("/items", (req, res) => {
    const name = String(req.body.name ?? "");
    // silent-save-failure (seeded bug): 20 文字超の名前は黙って捨てるが、成功したように見える
    if (name.length <= 20) {
      items.push({
        id: nextId++,
        name,
        price: parseInt(String(req.body.price ?? "0"), 10) || 0,
        quantity: parseInt(String(req.body.quantity ?? "1"), 10) || 1,
      });
    }
    res.redirect("/items");
  });

  app.post("/items/:id/delete", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) items.splice(idx, 1);
    res.redirect("/items");
  });

  app.get("/cart", (_req, res) => {
    // cart-total-wrong (seeded bug): 数量を無視して price の合計だけを返す
    const total = items.reduce((sum, i) => sum + i.price, 0);
    const rows = items.map((i) => `<tr><td>${i.name}</td><td>¥${i.price}</td><td>${i.quantity}</td><td>¥${i.price * i.quantity}</td></tr>`).join("\n");
    res.send(page("Cart", `
<table><thead><tr><th>Name</th><th>Price</th><th>Qty</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table>
<p><strong>Total: ¥${total}</strong></p>
<p><button class="buy">Checkout</button></p>`));
  });

  // admin-unprotected (seeded bug): 認証チェックなしで管理画面が開ける
  app.get("/admin", (_req, res) => {
    res.send(page("Admin", `
<p>Store administration. Manage inventory and dangerous operations.</p>
<form method="post" action="/admin/reset"><button class="delete">Reset all inventory</button></form>`));
  });

  app.post("/admin/reset", (_req, res) => {
    items.length = 0;
    res.redirect("/admin");
  });

  // broken-help-link (seeded bug): ナビから常にリンクされているのに存在しない
  // （/help ハンドラは意図的に定義しない → 404）

  return app;
}

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("app.ts")) {
  const port = parseInt(process.env.BENCH_PORT ?? "4319", 10);
  createBenchApp().listen(port, () => console.log(`[bench] sample app → http://localhost:${port}`));
}
