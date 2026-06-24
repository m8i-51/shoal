import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");

import * as fs from "fs";
import { loadPersonaPack, formatPackForPrompt, type PersonaPack } from "../persona-pack";

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  delete process.env.SHOAL_PERSONAS;
});

describe("formatPackForPrompt", () => {
  it("name とバージョンをヘッダーに含める", () => {
    const pack: PersonaPack = { name: "My Pack", version: "1.0.0", personas: [] };
    const result = formatPackForPrompt(pack);
    expect(result).toContain('"My Pack" v1.0.0');
  });

  it("version が無い場合は v 表記を省略する", () => {
    const pack: PersonaPack = { name: "My Pack", personas: [] };
    const result = formatPackForPrompt(pack);
    expect(result).toContain('"My Pack"');
    expect(result).not.toContain(" v");
  });

  it("各ペルソナを番号付きで列挙し、lenses があれば追加する", () => {
    const pack: PersonaPack = {
      name: "P", personas: [
        { name: "Aiko", role: "newcomer", persona: "first-time user", lenses: ["UX clarity", "Onboarding"] },
        { name: "Kenji", role: "power user", persona: "daily user" },
      ],
    };
    const result = formatPackForPrompt(pack);
    expect(result).toContain("1. Aiko (newcomer)");
    expect(result).toContain("Suggested lenses: UX clarity, Onboarding");
    expect(result).toContain("2. Kenji (power user)");
    expect(result).not.toContain("Kenji (power user)\n   daily user\n   Suggested");
  });
});

describe("loadPersonaPack", () => {
  describe("SHOAL_PERSONAS 未設定（ローカル自動検出）", () => {
    it("personas.yaml/yml/json がどれも無ければ null を返す", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(await loadPersonaPack()).toBeNull();
    });

    it("personas.yaml があれば YAML をパースして返す", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("personas.yaml"));
      vi.mocked(fs.readFileSync).mockReturnValue(`
name: "Test Pack"
personas:
  - name: "Aiko"
    role: "newcomer"
    persona: "first-time user"
` as unknown as ReturnType<typeof fs.readFileSync>);
      const pack = await loadPersonaPack();
      expect(pack?.name).toBe("Test Pack");
      expect(pack?.personas).toHaveLength(1);
      expect(pack?.personas[0].name).toBe("Aiko");
    });

    it("personas.json があれば JSON をパースして返す", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("personas.json"));
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ name: "JSON Pack", personas: [{ name: "Bob", role: "tester", persona: "QA" }] }) as unknown as ReturnType<typeof fs.readFileSync>
      );
      const pack = await loadPersonaPack();
      expect(pack?.name).toBe("JSON Pack");
    });
  });

  describe("SHOAL_PERSONAS がファイルパス（. または / で始まる）", () => {
    it("ファイルが存在しない場合は null を返す", async () => {
      process.env.SHOAL_PERSONAS = "./custom-personas.yaml";
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(await loadPersonaPack()).toBeNull();
    });

    it("ファイルが存在する場合はパースして返す", async () => {
      process.env.SHOAL_PERSONAS = "./custom-personas.yaml";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
personas:
  - name: "Carla"
    role: "accessibility"
    persona: "screen reader user"
` as unknown as ReturnType<typeof fs.readFileSync>);
      const pack = await loadPersonaPack();
      expect(pack?.personas[0].name).toBe("Carla");
    });

    it("パース結果がオブジェクト/配列でない場合は null を返す", async () => {
      process.env.SHOAL_PERSONAS = "./plain-string.yaml";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("just a plain string" as unknown as ReturnType<typeof fs.readFileSync>);
      expect(await loadPersonaPack()).toBeNull();
    });

    it("YAML パースに失敗した場合は null を返す", async () => {
      process.env.SHOAL_PERSONAS = "./broken.yaml";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("not: valid: yaml: :::" as unknown as ReturnType<typeof fs.readFileSync>);
      expect(await loadPersonaPack()).toBeNull();
    });

    it("bare array 形式（{personas:[...]} ではなく直接配列）にも対応する", async () => {
      process.env.SHOAL_PERSONAS = "./array.json";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([{ name: "Dan", role: "dev", persona: "engineer" }]) as unknown as ReturnType<typeof fs.readFileSync>
      );
      const pack = await loadPersonaPack();
      expect(pack?.personas).toHaveLength(1);
    });

    it("name/role/persona を欠くエントリはスキップする", async () => {
      process.env.SHOAL_PERSONAS = "./mixed.json";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ personas: [{ name: "Valid", role: "r", persona: "p" }, { name: "Invalid" }] }) as unknown as ReturnType<typeof fs.readFileSync>
      );
      const pack = await loadPersonaPack();
      expect(pack?.personas).toHaveLength(1);
      expect(pack?.personas[0].name).toBe("Valid");
    });

    it("有効なペルソナが0件なら null を返す", async () => {
      process.env.SHOAL_PERSONAS = "./empty.json";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ personas: [{ name: "Invalid" }] }) as unknown as ReturnType<typeof fs.readFileSync>
      );
      expect(await loadPersonaPack()).toBeNull();
    });

    it("personas フィールドが無いオブジェクトは null を返す", async () => {
      process.env.SHOAL_PERSONAS = "./noPersonas.json";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ foo: "bar" }) as unknown as ReturnType<typeof fs.readFileSync>);
      expect(await loadPersonaPack()).toBeNull();
    });

    it("name が無い場合はファイルパスを name として使う", async () => {
      process.env.SHOAL_PERSONAS = "./no-name.json";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ personas: [{ name: "X", role: "r", persona: "p" }] }) as unknown as ReturnType<typeof fs.readFileSync>
      );
      const pack = await loadPersonaPack();
      expect(pack?.name).toContain("no-name.json");
    });
  });

  describe("SHOAL_PERSONAS が npm パッケージ名", () => {
    it("存在しないパッケージの場合は null を返す", async () => {
      process.env.SHOAL_PERSONAS = "nonexistent-shoal-persona-pkg-xyz";
      expect(await loadPersonaPack()).toBeNull();
    });
  });
});
