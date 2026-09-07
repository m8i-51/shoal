import { describe, it, expect } from "vitest";
import {
  estimateImageTokens,
  estimateImageTokensInMessages,
  pngDimensions,
} from "../image-tokens";

/** A real PNG header for the given size — IHDR is all this module reads. */
function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

describe("pngDimensions", () => {
  it("IHDR から幅と高さを読む", () => {
    expect(pngDimensions(pngBase64(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("PNG でないものは null（捏造しない）", () => {
    expect(pngDimensions(Buffer.from("not a png at all, but long enough").toString("base64"))).toBeNull();
  });

  it("短すぎる・壊れた入力は null", () => {
    expect(pngDimensions("")).toBeNull();
    expect(pngDimensions("abc")).toBeNull();
    expect(pngDimensions(undefined as unknown as string)).toBeNull();
  });

  it("幅か高さが 0 の PNG は null", () => {
    expect(pngDimensions(pngBase64(0, 720))).toBeNull();
  });
});

describe("estimateImageTokens", () => {
  it("縮小不要なサイズは width*height/750", () => {
    // 800*600 = 480,000 px — under both the edge and area limits.
    expect(estimateImageTokens({ width: 800, height: 600 })).toBe(Math.ceil(480_000 / 750));
  });

  it("長辺 1568px を超える画像は縮小してから数える", () => {
    const raw = Math.ceil((4000 * 1000) / 750);
    const estimated = estimateImageTokens({ width: 4000, height: 1000 });
    expect(estimated).toBeLessThan(raw);
    // Longest edge clamped to 1568 → 1568 x 392.
    expect(estimated).toBe(Math.ceil((1568 * (1000 * (1568 / 4000))) / 750));
  });

  it("フルページの縦長スクリーンショットは面積上限まで縮小される", () => {
    // 1280x8000 is a routine full-page capture; charging raw pixels would
    // overstate its cost several times over.
    const estimated = estimateImageTokens({ width: 1280, height: 8000 });
    expect(estimated).toBeLessThanOrEqual(Math.ceil(1_150_000 / 750));
    expect(estimated).toBeGreaterThan(0);
  });
});

describe("estimateImageTokensInMessages", () => {
  const imageBlock = (b64: string) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: b64 },
  });

  it("全メッセージの画像ブロックを合算する", () => {
    const one = estimateImageTokens({ width: 800, height: 600 });
    const messages = [
      { role: "user", content: [{ type: "text", text: "look" }, imageBlock(pngBase64(800, 600))] },
      { role: "user", content: [imageBlock(pngBase64(800, 600))] },
    ];
    expect(estimateImageTokensInMessages(messages)).toBe(one * 2);
  });

  it("テキストだけ・文字列 content・配列でない入力では 0", () => {
    expect(estimateImageTokensInMessages([{ role: "user", content: "hello" }])).toBe(0);
    expect(estimateImageTokensInMessages([{ role: "user", content: [{ type: "text", text: "x" }] }])).toBe(0);
    expect(estimateImageTokensInMessages(undefined)).toBe(0);
    expect(estimateImageTokensInMessages("nope")).toBe(0);
  });

  it("base64 でない image ブロックや壊れたデータは無視する", () => {
    expect(estimateImageTokensInMessages([
      { role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] },
    ])).toBe(0);
    expect(estimateImageTokensInMessages([
      { role: "user", content: [imageBlock("////not-a-png////")] },
    ])).toBe(0);
  });

  it("tool_result の中の画像も数える（ブラウザのスクリーンショットはここに入る）", () => {
    const one = estimateImageTokens({ width: 800, height: 600 });
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "clicked Buy" },
              imageBlock(pngBase64(800, 600)),
            ],
          },
        ],
      },
    ];
    expect(estimateImageTokensInMessages(messages)).toBe(one);
  });

  it("tool_result の文字列 content は 0", () => {
    expect(estimateImageTokensInMessages([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ])).toBe(0);
  });
});
