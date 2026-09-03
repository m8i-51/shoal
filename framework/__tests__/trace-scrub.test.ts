import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { zipSync, unzipSync } from "fflate";
import {
  scrubTraceZip,
  registerSecret,
  registerSecrets,
  getKnownSecrets,
  clearKnownSecrets,
} from "../trace-scrub";

function makeTraceZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    zippable[name] = typeof value === "string" ? new TextEncoder().encode(value) : value;
  }
  return zipSync(zippable);
}

describe("scrubTraceZip", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trace-scrub-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("trace.trace 内のパスワードを除去する", async () => {
    const zipPath = path.join(cwd, "test.zip");
    const traceContent = JSON.stringify({ type: "action", params: { value: "SuperSecret123" } });
    fs.writeFileSync(
      zipPath,
      makeTraceZip({
        "trace.trace": traceContent,
        "0-trace.network": `{"value":"SuperSecret123 and more"}`,
      }),
    );

    const { replaced } = await scrubTraceZip(zipPath, ["SuperSecret123"]);
    expect(replaced).toBe(2);

    const after = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const decoder = new TextDecoder();
    expect(decoder.decode(after["trace.trace"])).not.toContain("SuperSecret123");
    expect(decoder.decode(after["trace.trace"])).toContain("********");
    expect(decoder.decode(after["0-trace.network"])).not.toContain("SuperSecret123");
  });

  it("他の内容はそのまま保持する", async () => {
    const zipPath = path.join(cwd, "test2.zip");
    fs.writeFileSync(
      zipPath,
      makeTraceZip({
        "trace.trace": "before SuperSecret123 after",
      }),
    );

    await scrubTraceZip(zipPath, ["SuperSecret123"]);

    const after = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const decoder = new TextDecoder();
    expect(decoder.decode(after["trace.trace"])).toBe("before ******** after");
  });

  it("4文字未満の secret は無視する", async () => {
    const zipPath = path.join(cwd, "test3.zip");
    fs.writeFileSync(
      zipPath,
      makeTraceZip({
        "trace.trace": "the abc is short",
      }),
    );

    const { replaced } = await scrubTraceZip(zipPath, ["abc"]);
    expect(replaced).toBe(0);

    const after = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const decoder = new TextDecoder();
    expect(decoder.decode(after["trace.trace"])).toBe("the abc is short");
  });

  it("resources/ 配下のバイナリは書き換えない", async () => {
    const zipPath = path.join(cwd, "test4.zip");
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    fs.writeFileSync(
      zipPath,
      makeTraceZip({
        "trace.trace": "password is SuperSecret123",
        "resources/abc123.png": pngBytes,
      }),
    );

    const { replaced } = await scrubTraceZip(zipPath, ["SuperSecret123"]);
    expect(replaced).toBe(1);

    const after = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    expect(after["resources/abc123.png"]).toEqual(pngBytes);
  });

  it("secret が見つからなければ replaced は 0 で zip を書き換えない", async () => {
    const zipPath = path.join(cwd, "test5.zip");
    const original = makeTraceZip({ "trace.trace": "nothing secret here" });
    fs.writeFileSync(zipPath, original);
    const originalBytes = fs.readFileSync(zipPath);

    const { replaced } = await scrubTraceZip(zipPath, ["SuperSecret123"]);
    expect(replaced).toBe(0);
    expect(fs.readFileSync(zipPath)).toEqual(originalBytes);
  });

  it("secrets が空配列ならファイルを読みもしない", async () => {
    const zipPath = path.join(cwd, "does-not-exist.zip");
    const { replaced } = await scrubTraceZip(zipPath, []);
    expect(replaced).toBe(0);
  });
});

describe("known secrets registry", () => {
  beforeEach(() => {
    clearKnownSecrets();
  });

  it("registerSecret は4文字以上のみ登録する", () => {
    registerSecret("ab");
    registerSecret("abcd");
    registerSecret(undefined);
    registerSecret(null);
    expect(getKnownSecrets()).toEqual(["abcd"]);
  });

  it("registerSecrets は複数値をまとめて登録する", () => {
    registerSecrets(["pass1234", "x", undefined, "pass5678"]);
    expect(getKnownSecrets().sort()).toEqual(["pass1234", "pass5678"]);
  });

  it("clearKnownSecrets でリセットできる", () => {
    registerSecret("pass1234");
    clearKnownSecrets();
    expect(getKnownSecrets()).toEqual([]);
  });
});
