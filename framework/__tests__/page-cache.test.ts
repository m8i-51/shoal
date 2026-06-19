import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

import { loadPageHashes, updatePageHashes, hashContent } from "../page-cache";

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
});

describe("hashContent", () => {
  it("同じ文字列は常に同じハッシュを返す", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("異なる文字列は異なるハッシュを返す", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("空文字列も一意のハッシュを返す", () => {
    const h = hashContent("");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("16文字に切り詰められる", () => {
    expect(hashContent("any content").length).toBe(16);
  });
});

describe("loadPageHashes", () => {
  it("キャッシュファイルがない場合は空オブジェクトを返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadPageHashes("localhost:3000")).toEqual({});
  });

  it("キャッシュファイルがある場合はパースして返す", () => {
    const data = { "/home": "abc123", "/about": "def456" };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data) as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadPageHashes("localhost:3000")).toEqual(data);
  });

  it("壊れた JSON は空オブジェクトを返す（例外を投げない）", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json{{{" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(() => loadPageHashes("localhost:3000")).not.toThrow();
    expect(loadPageHashes("localhost:3000")).toEqual({});
  });

  it("ホスト名の特殊文字（: や /）はファイルパスで - に変換される", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{}" as unknown as ReturnType<typeof fs.readFileSync>);
    loadPageHashes("localhost:3000");
    const checkedPath = vi.mocked(fs.existsSync).mock.calls[0][0] as string;
    expect(checkedPath).not.toContain(":");
    expect(checkedPath).toContain("localhost-3000");
  });
});

describe("updatePageHashes", () => {
  it("空の updates を渡すと書き込みをしない", () => {
    updatePageHashes("localhost:3000", {});
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("既存データと新データをマージして書き込む", () => {
    const existing = { "/home": "old_hash", "/about": "about_hash" };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing) as unknown as ReturnType<typeof fs.readFileSync>);

    updatePageHashes("localhost:3000", { "/home": "new_hash", "/contact": "contact_hash" });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written["/home"]).toBe("new_hash");       // 上書き
    expect(written["/about"]).toBe("about_hash");    // 既存を保持
    expect(written["/contact"]).toBe("contact_hash"); // 新規追加
  });

  it("複数回呼ぶと蓄積される", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    updatePageHashes("localhost:3000", { "/a": "hash_a" });
    // 2回目: 1回目の書き込み内容を既存として読み込む
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ "/a": "hash_a" }) as unknown as ReturnType<typeof fs.readFileSync>);
    updatePageHashes("localhost:3000", { "/b": "hash_b" });

    const lastWrite = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string);
    expect(lastWrite["/a"]).toBe("hash_a");
    expect(lastWrite["/b"]).toBe("hash_b");
  });

  it("書き込み前にディレクトリを作成する", () => {
    updatePageHashes("localhost:3000", { "/x": "hash_x" });
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });
});
