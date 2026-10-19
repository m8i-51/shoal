import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  emptyExploreGraph,
  parseClickableControls,
  observeScreen,
  recordPress,
  suggestFrontier,
  formatFrontierHint,
  formatOpenBranches,
  formatExploreGraphLogLine,
  loadExploreGraph,
  saveExploreGraph,
  MAX_CONTROLS_PER_SCREEN,
  MAX_EXPLORE_SCREENS,
} from "../explore-graph";

const ORIGIN = "https://app.example.com";

function chain(names: string[]): ReturnType<typeof emptyExploreGraph> {
  const graph = emptyExploreGraph(ORIGIN);
  for (let i = 0; i < names.length - 1; i++) {
    const from = `/s${i}`;
    const to = `/s${i + 1}`;
    observeScreen(graph, from, [{ role: "button", name: names[i] }]);
    recordPress(graph, from, names[i], to);
  }
  return graph;
}

describe("parseClickableControls", () => {
  it("keeps named clickable roles and skips headings, generics, and nameless controls", () => {
    const snapshot = [
      `- heading "Tutorial" [ref=e1]`,
      `- generic [ref=e10]:`,
      `  - button "Close" [ref=e2]`,
      `  - button "Next" [ref=e3]`,
      `  - link "Settings" [ref=e4]:`,
      `  - button [ref=e5]`,
      `  - textbox "Email" [ref=e6]`,
    ].join("\n");

    expect(parseClickableControls(snapshot)).toEqual([
      { role: "button", name: "Close" },
      { role: "button", name: "Next" },
      { role: "link", name: "Settings" },
    ]);
  });
});

describe("suggestFrontier", () => {
  it("keeps the shared prefix open so the untried sibling can still be reached", () => {
    // 1→2→3→4→5→6 was taken. 7 sits next to 6 and has not been pressed.
    const graph = chain(["1", "2", "3", "4", "5", "6"]);
    observeScreen(graph, "/s5", [
      { role: "button", name: "6" },
      { role: "button", name: "7" },
    ]);
    recordPress(graph, "/s5", "6", "/s6");
    observeScreen(graph, "/s6", []);

    expect(suggestFrontier(graph, "/s5")).toEqual({ kind: "press", labels: ['button "7"'] });
    expect(formatFrontierHint(graph, "/s5")).toContain("Unpressed controls");
    expect(suggestFrontier(graph, "/s4")).toEqual({ kind: "revisit", labels: ['button "5"'], steps: 1 });
    expect(suggestFrontier(graph, "/s0")).toEqual({ kind: "revisit", labels: ['button "1"'], steps: 5 });

    const hint = formatFrontierHint(graph, "/s0");
    expect(hint).toContain('button "1"');
    expect(hint).toContain("not finished");
  });

  it("settles the prefix only after the sibling branch is taken", () => {
    const graph = chain(["1", "2", "3", "4", "5", "6"]);
    observeScreen(graph, "/s5", [
      { role: "button", name: "6" },
      { role: "button", name: "7" },
    ]);
    recordPress(graph, "/s5", "6", "/s6");
    observeScreen(graph, "/s6", []);
    recordPress(graph, "/s5", "7", "/s7");
    observeScreen(graph, "/s7", []);

    expect(suggestFrontier(graph, "/s5").kind).toBe("back-or-scroll");
    expect(suggestFrontier(graph, "/s0").kind).toBe("back-or-scroll");
    expect(formatFrontierHint(graph, "/s0")).toContain("Go back");
  });

  it("revisits only the control whose unfinished branch is closest", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/home", [
      { role: "link", name: "Done" },
      { role: "link", name: "Reports" },
    ]);
    recordPress(graph, "/home", "Done", "/done");
    observeScreen(graph, "/done", []);
    recordPress(graph, "/home", "Reports", "/reports");
    observeScreen(graph, "/reports", [{ role: "button", name: "Export" }]);

    expect(suggestFrontier(graph, "/home")).toEqual({
      kind: "revisit",
      labels: ['link "Reports"'],
      steps: 1,
    });
  });

  it("treats an unobserved destination as still open", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/home", [{ role: "button", name: "Next" }]);
    recordPress(graph, "/home", "Next", "/next");

    expect(suggestFrontier(graph, "/home")).toEqual({
      kind: "revisit",
      labels: ['button "Next"'],
      steps: 1,
    });
  });

  it("terminates when two screens only point at each other", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/a", [{ role: "button", name: "To B" }]);
    observeScreen(graph, "/b", [{ role: "button", name: "To A" }]);
    recordPress(graph, "/a", "To B", "/b");
    recordPress(graph, "/b", "To A", "/a");

    expect(suggestFrontier(graph, "/a").kind).toBe("back-or-scroll");
    expect(suggestFrontier(graph, "/b").kind).toBe("back-or-scroll");
  });

  it("returns unknown until the screen has been observed", () => {
    const graph = emptyExploreGraph(ORIGIN);
    expect(suggestFrontier(graph, "/missing")).toEqual({ kind: "unknown" });
    expect(formatFrontierHint(graph, "/missing")).toBeNull();
  });
});

describe("observeScreen", () => {
  it("drops unpressed controls that left the screen and keeps pressed ones", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/menu", [
      { role: "button", name: "Stay" },
      { role: "button", name: "Gone" },
    ]);
    recordPress(graph, "/menu", "Stay", "/menu");
    observeScreen(graph, "/menu", [{ role: "button", name: "Stay" }]);

    const keys = Object.keys(graph.screens["/menu"].controls).sort();
    expect(keys).toEqual(["button:stay"]);
    expect(graph.screens["/menu"].controls["button:stay"].pressCount).toBe(1);
  });

  it("does not record presses on excluded paths", () => {
    const graph = emptyExploreGraph(ORIGIN);
    expect(recordPress(graph, "/logout", "Log out", "/")).toBeNull();
    expect(graph.screens["/logout"]).toBeUndefined();
  });

  it("stops adding controls past the per-screen cap", () => {
    const graph = emptyExploreGraph(ORIGIN);
    const seen = Array.from({ length: MAX_CONTROLS_PER_SCREEN + 5 }, (_, i) => ({
      role: "button",
      name: `Item ${i}`,
    }));
    observeScreen(graph, "/long", seen);
    expect(Object.keys(graph.screens["/long"].controls)).toHaveLength(MAX_CONTROLS_PER_SCREEN);
  });

  it("stops adding screens past the graph cap", () => {
    const graph = emptyExploreGraph(ORIGIN);
    for (let i = 0; i < MAX_EXPLORE_SCREENS; i++) {
      observeScreen(graph, `/p${i}`, []);
    }
    expect(observeScreen(graph, "/overflow", [{ role: "button", name: "More" }])).toBeNull();
    expect(graph.screens["/overflow"]).toBeUndefined();
  });
});

describe("recordPress", () => {
  it("matches a wordy click description onto the observed control", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/home", [
      { role: "button", name: "Save" },
      { role: "button", name: "Save" },
    ]);
    recordPress(graph, "/home", 'the "Save" button', "/done");
    expect(graph.screens["/home"].controls["button:save"].pressCount).toBe(1);
    expect(graph.screens["/home"].controls["button:save#2"].pressCount).toBe(0);

    recordPress(graph, "/home", 'the "Save" button', "/done");
    expect(graph.screens["/home"].controls["button:save#2"].pressCount).toBe(1);
    expect(graph.screens["/home"].controls["click:save"]).toBeUndefined();
  });

  it("records an unknown description as its own control", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/home", [{ role: "button", name: "Save" }]);
    recordPress(graph, "/home", "mystery control", null);
    expect(graph.screens["/home"].controls["click:mystery control"].destinations["/home"]).toBe(1);
  });
});

describe("formatOpenBranches", () => {
  it("lists screens that still have an unpressed control", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/settings", [
      { role: "link", name: "Billing" },
      { role: "link", name: "Team" },
    ]);
    observeScreen(graph, "/home", [{ role: "link", name: "Settings" }]);
    recordPress(graph, "/home", "Settings", "/settings");

    const text = formatOpenBranches(graph);
    expect(text).toContain("/settings:");
    expect(text).toContain('link "Billing"');
    expect(text).toContain('link "Team"');
    expect(text).not.toContain("/home:");
  });

  it("says when nothing is open and counts screens for the log line", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/done", []);
    expect(formatOpenBranches(graph)).toContain("none");
    expect(formatExploreGraphLogLine(graph)).toBe("[explore-graph] screens=1 open=0");
  });
});

describe("loadExploreGraph / saveExploreGraph", () => {
  const tmpDir = path.join(os.tmpdir(), `explore-graph-test-${Date.now()}`);
  const prevCwd = process.cwd();

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips through coverage/explore-graph.json", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/home", [{ role: "button", name: "Next" }]);
    recordPress(graph, "/home", "Next", "/next");
    saveExploreGraph(graph);

    const loaded = loadExploreGraph(ORIGIN);
    expect(loaded.screens["/home"].controls["button:next"].pressCount).toBe(1);
    expect(loaded.screens["/home"].controls["button:next"].destinations["/next"]).toBe(1);
  });

  it("returns an empty graph for a different origin", () => {
    const graph = emptyExploreGraph(ORIGIN);
    observeScreen(graph, "/home", []);
    saveExploreGraph(graph);
    expect(loadExploreGraph("https://other.example.com").screens).toEqual({});
  });

  it("quarantines a corrupt file", () => {
    const filePath = path.join(tmpDir, "coverage", "explore-graph.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not-json", "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = loadExploreGraph(ORIGIN);

    expect(loaded.screens).toEqual({});
    expect(fs.existsSync(filePath)).toBe(false);
    const quarantined = fs.readdirSync(path.dirname(filePath)).find((f) => f.includes(".corrupt-"));
    expect(quarantined).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toContain("explore-graph.json");
    warnSpy.mockRestore();
  });
});
