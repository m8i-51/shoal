/**
 * image-tokens.ts — how much of a run's input spend was screenshots.
 *
 * Browser and threshold agents send a full-page PNG with almost every turn, so
 * images are usually the majority of a run's input tokens. The run log reported
 * one `inputTokens` figure, which left an operator looking at a surprising bill
 * with no way to tell whether the cause was chatty prompts or screenshot
 * volume — and those have opposite fixes (shorter prompts vs. fewer turns or a
 * smaller viewport).
 *
 * Providers do not report an image/text split, so this estimates it from the
 * images we sent, using Anthropic's published sizing rule. The result is
 * labelled an estimate everywhere it is shown, and it is never used for
 * billing or for the spend cap — those stay on the provider's own token counts.
 */

/** Anthropic: tokens ≈ (width × height) / 750. */
const PIXELS_PER_TOKEN = 750;

/** Images are downscaled so the longest edge is at most this many pixels. */
const MAX_EDGE_PX = 1568;

/** …and so the total area is at most roughly this many pixels. */
const MAX_AREA_PX = 1_150_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read width/height out of a base64 PNG without decoding the whole image.
 *
 * A PNG's IHDR chunk is at a fixed offset, so the first 24 bytes are enough —
 * decoding 32 base64 characters instead of a megabyte of screenshot.
 * Returns null for anything that is not a PNG, which is every other format
 * shoal could start sending later; an unknown image contributes nothing rather
 * than a fabricated number.
 */
export function pngDimensions(base64: string): ImageDimensions | null {
  if (typeof base64 !== "string" || base64.length < 32) return null;
  let header: Buffer;
  try {
    header = Buffer.from(base64.slice(0, 32), "base64");
  } catch {
    return null;
  }
  if (header.length < 24) return null;
  // \x89PNG\r\n\x1a\n
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (header[i] !== signature[i]) return null;
  }
  if (header.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Estimated input tokens for one image, after the resizing the API applies.
 *
 * Modelling the downscale matters for shoal specifically: a full-page
 * screenshot of a long page is far past both limits, so charging for its raw
 * pixel count would overstate image cost several times over.
 */
export function estimateImageTokens(dimensions: ImageDimensions): number {
  const { width, height } = dimensions;
  let scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
  const scaledArea = width * scale * height * scale;
  if (scaledArea > MAX_AREA_PX) {
    scale *= Math.sqrt(MAX_AREA_PX / scaledArea);
  }
  return Math.ceil((width * scale * height * scale) / PIXELS_PER_TOKEN);
}

/** An image content block as the Messages API takes it. */
function imageBase64(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; source?: unknown };
  if (b.type !== "image") return null;
  const source = b.source as { type?: unknown; data?: unknown } | undefined;
  if (source?.type !== "base64" || typeof source.data !== "string") return null;
  return source.data;
}

/**
 * Walk message content looking for base64 PNG blocks.
 *
 * Browser screenshots are almost never top-level `image` blocks: `tool-session`
 * wraps each tool's return in a `tool_result`, and the screenshot lives in
 * that nested `content` array. A walker that only looked at `message.content`
 * therefore reported ~0 image tokens on a real run.
 */
function addImageTokensFrom(value: unknown, acc: { total: number }): void {
  if (Array.isArray(value)) {
    for (const item of value) addImageTokensFrom(item, acc);
    return;
  }
  if (!value || typeof value !== "object") return;
  const data = imageBase64(value);
  if (data) {
    const dimensions = pngDimensions(data);
    if (dimensions) acc.total += estimateImageTokens(dimensions);
    return;
  }
  const block = value as { type?: unknown; content?: unknown };
  if (block.type === "tool_result") addImageTokensFrom(block.content, acc);
}

/**
 * Estimated image input tokens across a whole `messages` array.
 *
 * Walks both shapes a message's `content` can take (a plain string, or a block
 * array), recurses into `tool_result` content, and ignores anything that is
 * not a base64 image.
 */
export function estimateImageTokensInMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  const acc = { total: 0 };
  for (const message of messages) {
    addImageTokensFrom((message as { content?: unknown } | undefined)?.content, acc);
  }
  return acc.total;
}
