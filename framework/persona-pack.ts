import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

export interface PersonaTemplate {
  name: string;
  role: string;
  persona: string;
  lenses?: string[];
}

export interface PersonaPack {
  name: string;
  version?: string;
  personas: PersonaTemplate[];
}

function isPersonaTemplate(v: unknown): v is PersonaTemplate {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.role === "string" && typeof o.persona === "string";
}

function parseRaw(raw: unknown, source: string): PersonaPack | null {
  if (typeof raw !== "object" || raw === null) {
    console.warn(`[persona-pack] ${source}: expected an object, got ${typeof raw}`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  // Support { personas: [...] } or bare array
  const list = Array.isArray(obj) ? obj : Array.isArray(obj.personas) ? obj.personas : null;
  if (!list) {
    console.warn(`[persona-pack] ${source}: no "personas" array found`);
    return null;
  }

  const personas = list.filter((v) => {
    if (!isPersonaTemplate(v)) {
      console.warn(`[persona-pack] ${source}: skipping invalid entry (missing name/role/persona)`);
      return false;
    }
    return true;
  }) as PersonaTemplate[];

  if (personas.length === 0) {
    console.warn(`[persona-pack] ${source}: 0 valid personas found`);
    return null;
  }

  const packName = typeof obj.name === "string" ? obj.name : source;
  const version = typeof obj.version === "string" ? obj.version : undefined;
  return { name: packName, version, personas };
}

function loadFromFile(filePath: string): PersonaPack | null {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) {
    console.warn(`[persona-pack] file not found: ${resolved}`);
    return null;
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const ext = path.extname(resolved).toLowerCase();
  let raw: unknown;
  try {
    raw = ext === ".json" ? JSON.parse(content) : parseYaml(content);
  } catch (e) {
    console.warn(`[persona-pack] failed to parse ${resolved}: ${e}`);
    return null;
  }
  return parseRaw(raw, resolved);
}

async function loadFromPackage(packageName: string): Promise<PersonaPack | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await import(packageName);
    // Support both default export and named export
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const raw = mod?.default ?? mod?.personas ? { personas: mod.personas } : mod;
    return parseRaw(raw, packageName);
  } catch (e) {
    console.warn(`[persona-pack] failed to load package "${packageName}": ${e}`);
    return null;
  }
}

function lookupLocalDefault(): PersonaPack | null {
  for (const name of ["personas.yaml", "personas.yml", "personas.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return loadFromFile(p);
  }
  return null;
}

export async function loadPersonaPack(): Promise<PersonaPack | null> {
  const source = process.env.SHOAL_PERSONAS?.trim();

  if (!source) {
    // Auto-discover personas.yaml / personas.yml / personas.json in cwd
    const pack = lookupLocalDefault();
    if (pack) console.log(`[persona-pack] loaded "${pack.name}" (${pack.personas.length} templates)`);
    return pack;
  }

  // Looks like a file path
  if (source.startsWith(".") || source.startsWith("/")) {
    const pack = loadFromFile(source);
    if (pack) console.log(`[persona-pack] loaded "${pack.name}" (${pack.personas.length} templates) from ${source}`);
    return pack;
  }

  // Treat as npm package name
  const pack = await loadFromPackage(source);
  if (pack) console.log(`[persona-pack] loaded "${pack.name}" (${pack.personas.length} templates) from package ${source}`);
  return pack;
}

export function formatPackForPrompt(pack: PersonaPack): string {
  const lines = [
    `[Persona Templates from "${pack.name}"${pack.version ? ` v${pack.version}` : ""}]`,
    "Prefer using these as a starting point. You may adapt names/personas to fit the app, but keep the role archetype intact.",
    "",
    ...pack.personas.map((p, i) =>
      [
        `${i + 1}. ${p.name} (${p.role})`,
        `   ${p.persona}`,
        ...(p.lenses?.length ? [`   Suggested lenses: ${p.lenses.join(", ")}`] : []),
      ].join("\n")
    ),
  ];
  return lines.join("\n");
}
