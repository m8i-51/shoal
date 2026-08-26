import { describe, it, expect } from "vitest";
import { parseShoalArgs } from "../../bin/cli-args.js";

describe("parseShoalArgs", () => {
  it("サブコマンドとフラグを分離する", () => {
    expect(parseShoalArgs(["node", "shoal", "serve", "--dir", "apps/shoal"])).toEqual({
      dir: "apps/shoal",
      envFile: undefined,
      rest: ["serve"],
    });
  });

  it("--dir / --env-file をサブコマンドの前に置いても読む", () => {
    expect(parseShoalArgs(["node", "shoal", "--dir", "cfg", "--env-file", "cfg/.env", "serve"])).toEqual({
      dir: "cfg",
      envFile: "cfg/.env",
      rest: ["serve"],
    });
  });

  it("diff の --base は rest に残す", () => {
    expect(parseShoalArgs(["node", "shoal", "diff", "--base", "origin/dev", "--dir", "apps/shoal"])).toEqual({
      dir: "apps/shoal",
      envFile: undefined,
      rest: ["diff", "--base", "origin/dev"],
    });
  });

  it("フラグが無ければ rest はそのまま", () => {
    expect(parseShoalArgs(["node", "shoal"])).toEqual({
      dir: undefined,
      envFile: undefined,
      rest: [],
    });
  });
});
