import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Normalize `npm pack --json` across npm 10 (array) and npm 12 (name-keyed object). */
export function packFilePaths(data) {
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  const pack = selectPack(parsed);
  if (!pack || !Array.isArray(pack.files)) {
    throw new Error(`unexpected npm pack --json shape: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return pack.files.map((file) => {
    if (typeof file === "string") return file;
    if (file && typeof file === "object" && typeof file.path === "string") {
      return file.path;
    }
    throw new Error(`unexpected pack file entry: ${JSON.stringify(file)}`);
  });
}

function selectPack(parsed) {
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.files)) return parsed;
    const first = Object.values(parsed)[0];
    if (first && typeof first === "object") return first;
  }
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = fs.readFileSync(0, "utf8");
  for (const filePath of packFilePaths(raw)) {
    console.log(filePath);
  }
}
