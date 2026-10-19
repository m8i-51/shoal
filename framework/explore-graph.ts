import * as fs from "fs";
import * as path from "path";
import { clickNameCandidates } from "./click-target";
import { isExcludedPath } from "./site-map";
import { quarantineCorruptFile, writeFileAtomic } from "./atomic-write";

/**
 * Action-level explore memory.
 *
 * The site map records which paths were visited. This graph records which
 * control was pressed on which screen, and which screen that press led to.
 * A control stays unfinished until every branch past it has been tried:
 * pressing 1→2→3→4→5→6 must not close 1→2→3→4→5→7.
 */

export const MAX_EXPLORE_SCREENS = 2000;
export const MAX_CONTROLS_PER_SCREEN = 60;
const MAX_LABEL_LENGTH = 120;
const SETTLED = Number.POSITIVE_INFINITY;

const CLICKABLE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
]);

const SNAPSHOT_LINE = /^\s*-\s+([A-Za-z]+)(?:\s+"([^"]*)")?/;

export interface ExploreControl {
  key: string;
  label: string;
  role: string;
  pressCount: number;
  /** Destination path → how many times this control led there. */
  destinations: Record<string, number>;
}

export interface ExploreScreen {
  path: string;
  /** True once a snapshot of this screen's controls has been recorded. */
  observed: boolean;
  controls: Record<string, ExploreControl>;
}

export interface ExploreGraph {
  origin: string;
  updatedAt: string;
  screens: Record<string, ExploreScreen>;
}

export interface ClickableControl {
  role: string;
  name: string;
}

export type FrontierSuggestion =
  | { kind: "unknown" }
  | { kind: "press"; labels: string[] }
  | { kind: "revisit"; labels: string[]; steps: number }
  | { kind: "back-or-scroll" };

function graphFilePath(): string {
  return path.join(process.cwd(), "coverage", "explore-graph.json");
}

export function emptyExploreGraph(origin: string): ExploreGraph {
  return {
    origin: origin.replace(/\/$/, ""),
    updatedAt: new Date().toISOString(),
    screens: {},
  };
}

export function normalizeControlName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_LABEL_LENGTH);
}

export function controlLabel(control: ExploreControl): string {
  if (control.role === "click") return `"${control.label}"`;
  return `${control.role} "${control.label}"`;
}

/** Pull named clickable controls out of a Playwright aria snapshot. */
export function parseClickableControls(snapshot: string): ClickableControl[] {
  const out: ClickableControl[] = [];
  for (const line of snapshot.split("\n")) {
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
    const role = match[1].toLowerCase();
    if (!CLICKABLE_ROLES.has(role)) continue;
    const name = (match[2] ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
    if (!name) continue;
    out.push({ role, name });
  }
  return out;
}

function controlKey(role: string, name: string): string {
  return `${role}:${normalizeControlName(name)}`;
}

function ensureScreen(graph: ExploreGraph, pathname: string): ExploreScreen | null {
  if (!pathname || isExcludedPath(pathname)) return null;
  const existing = graph.screens[pathname];
  if (existing) return existing;
  if (Object.keys(graph.screens).length >= MAX_EXPLORE_SCREENS) return null;
  const screen: ExploreScreen = { path: pathname, observed: false, controls: {} };
  graph.screens[pathname] = screen;
  return screen;
}

/**
 * Merge a fresh list of controls into the screen.
 * Unpressed controls that are no longer on screen are dropped.
 * Pressed controls stay, so a closed menu does not erase history.
 */
export function observeScreen(
  graph: ExploreGraph,
  pathname: string,
  seen: ClickableControl[],
): ExploreScreen | null {
  const screen = ensureScreen(graph, pathname);
  if (!screen) return null;

  const seenKeys = new Set<string>();
  const counts = new Map<string, number>();
  for (const control of seen) {
    const base = controlKey(control.role, control.name);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;
    seenKeys.add(key);
    if (screen.controls[key]) continue;
    if (Object.keys(screen.controls).length >= MAX_CONTROLS_PER_SCREEN) continue;
    screen.controls[key] = {
      key,
      label: control.name,
      role: control.role,
      pressCount: 0,
      destinations: {},
    };
  }

  for (const key of Object.keys(screen.controls)) {
    const control = screen.controls[key];
    if (control.pressCount === 0 && !seenKeys.has(key)) {
      delete screen.controls[key];
    }
  }

  screen.observed = true;
  return screen;
}

function scoreName(label: string, candidates: string[]): number {
  const name = normalizeControlName(label);
  if (!name) return 0;
  let best = 0;
  for (const raw of candidates) {
    const candidate = normalizeControlName(raw);
    if (!candidate) continue;
    if (name === candidate) best = Math.max(best, 200);
    else if (name.includes(candidate) || candidate.includes(name)) {
      best = Math.max(best, 40 + Math.min(name.length, candidate.length));
    }
  }
  return best;
}

function matchControl(screen: ExploreScreen, description: string): ExploreControl | undefined {
  const candidates = clickNameCandidates(description);
  let best: ExploreControl | undefined;
  let bestScore = 0;
  for (const control of Object.values(screen.controls)) {
    const score = scoreName(control.label, candidates);
    if (score < 40) continue;
    const better = score > bestScore;
    const preferUnpressed =
      score === bestScore && best !== undefined && best.pressCount > 0 && control.pressCount === 0;
    if (better || preferUnpressed) {
      best = control;
      bestScore = score;
    }
  }
  return best;
}

function addSynthetic(screen: ExploreScreen, description: string): ExploreControl | null {
  const candidates = clickNameCandidates(description);
  const label = (candidates[0] ?? description).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  const key = `click:${normalizeControlName(label) || "unknown"}`;
  const existing = screen.controls[key];
  if (existing) return existing;
  if (Object.keys(screen.controls).length >= MAX_CONTROLS_PER_SCREEN) return null;
  const created: ExploreControl = {
    key,
    label: label || description.slice(0, MAX_LABEL_LENGTH),
    role: "click",
    pressCount: 0,
    destinations: {},
  };
  screen.controls[key] = created;
  return created;
}

/** Record a successful press and the screen it landed on. */
export function recordPress(
  graph: ExploreGraph,
  fromPath: string,
  description: string,
  toPath: string | null,
): ExploreControl | null {
  if (!fromPath || isExcludedPath(fromPath)) return null;
  if (!description.trim()) return null;
  const screen = ensureScreen(graph, fromPath);
  if (!screen) return null;
  const dest = toPath && !isExcludedPath(toPath) ? toPath : fromPath;
  const control = matchControl(screen, description) ?? addSynthetic(screen, description);
  if (!control) return null;
  control.pressCount += 1;
  control.destinations[dest] = (control.destinations[dest] ?? 0) + 1;
  screen.observed = true;
  return control;
}

function screenOpenDistance(
  graph: ExploreGraph,
  pathname: string,
  stack: Set<string>,
  memo: Map<string, number>,
): number {
  if (stack.has(pathname)) return SETTLED;
  const cached = memo.get(pathname);
  if (cached !== undefined) return cached;

  const screen = graph.screens[pathname];
  if (!screen || !screen.observed) return 0;

  const controls = Object.values(screen.controls);
  if (controls.some((control) => control.pressCount === 0)) return 0;
  if (controls.length === 0) return SETTLED;

  stack.add(pathname);
  let best = SETTLED;
  for (const control of controls) {
    best = Math.min(best, controlLeadDistance(graph, control, stack, memo));
  }
  stack.delete(pathname);
  memo.set(pathname, best);
  return best;
}

/** Steps from a pressed control to the nearest untried control. SETTLED when none remain. */
function controlLeadDistance(
  graph: ExploreGraph,
  control: ExploreControl,
  stack: Set<string>,
  memo: Map<string, number>,
): number {
  const destinations = Object.keys(control.destinations);
  if (destinations.length === 0) return 1;
  let best = SETTLED;
  for (const dest of destinations) {
    best = Math.min(best, 1 + screenOpenDistance(graph, dest, stack, memo));
  }
  return best;
}

/**
 * What to do on this screen:
 * 1. an unpressed control, if any
 * 2. otherwise the pressed control whose downstream untried branch is closest
 * 3. otherwise go back or scroll — everything known past here is finished
 */
export function suggestFrontier(graph: ExploreGraph, pathname: string): FrontierSuggestion {
  const screen = graph.screens[pathname];
  if (!screen?.observed) return { kind: "unknown" };

  const controls = Object.values(screen.controls);
  const unpressed = controls.filter((control) => control.pressCount === 0);
  if (unpressed.length > 0) {
    return { kind: "press", labels: unpressed.map(controlLabel).sort() };
  }

  const memo = new Map<string, number>();
  const stack = new Set<string>([pathname]);
  const open = controls
    .map((control) => ({ control, steps: controlLeadDistance(graph, control, stack, memo) }))
    .filter((row) => row.steps < SETTLED);
  if (open.length === 0) return { kind: "back-or-scroll" };

  const steps = Math.min(...open.map((row) => row.steps));
  const labels = open
    .filter((row) => row.steps === steps)
    .map((row) => controlLabel(row.control))
    .sort();
  return { kind: "revisit", labels, steps };
}

function bulletList(labels: string[], limit = 8): string {
  const shown = labels.slice(0, limit);
  const extra = labels.length - shown.length;
  const lines = shown.map((label) => `- ${label}`);
  if (extra > 0) lines.push(`- …and ${extra} more`);
  return lines.join("\n");
}

/** Turn hint for a free-exploration agent. Null when this screen is not mapped yet. */
export function formatFrontierHint(graph: ExploreGraph, pathname: string): string | null {
  const suggestion = suggestFrontier(graph, pathname);
  switch (suggestion.kind) {
    case "unknown":
      return null;
    case "press":
      return [
        "[explore frontier] Unpressed controls on this screen. Press one of these before repeating a control you already used:",
        bulletList(suggestion.labels),
      ].join("\n");
    case "revisit": {
      const joined = suggestion.labels.join(" or ");
      const again = suggestion.labels.length === 1 ? "Press it again" : "Press one of them again";
      const noun = suggestion.labels.length === 1 ? "It is" : "These are";
      const stepWord = suggestion.steps === 1 ? "step" : "steps";
      return `[explore frontier] Every control here has been pressed, but ${joined} still leads to an untried branch (${suggestion.steps} ${stepWord} ahead). ${again} and take the branch you have not taken. ${noun} not finished.`;
    }
    case "back-or-scroll":
      return "[explore frontier] Known controls from this screen are fully explored, including everything they lead to. Go back, or scroll to reveal a control that is not in the map yet.";
    default: {
      const _exhaustive: never = suggestion;
      return _exhaustive;
    }
  }
}

export function formatOpenBranches(graph: ExploreGraph, topN = 8): string {
  const open = Object.values(graph.screens)
    .map((screen) => ({
      path: screen.path,
      unpressed: Object.values(screen.controls)
        .filter((control) => control.pressCount === 0)
        .map(controlLabel)
        .sort(),
    }))
    .filter((screen) => screen.unpressed.length > 0)
    .sort((a, b) => b.unpressed.length - a.unpressed.length || a.path.localeCompare(b.path))
    .slice(0, topN);

  if (open.length === 0) {
    return "Open action branches: (none — no screen has an unpressed control yet)";
  }

  return [
    "Open action branches (a pressed control stays unfinished until every branch past it has been tried):",
    ...open.map((screen) => `- ${screen.path}: ${screen.unpressed.join(", ")}`),
  ].join("\n");
}

export function formatExploreGraphLogLine(graph: ExploreGraph): string {
  const screens = Object.keys(graph.screens).length;
  const open = Object.values(graph.screens).filter((screen) =>
    Object.values(screen.controls).some((control) => control.pressCount === 0),
  ).length;
  return `[explore-graph] screens=${screens} open=${open}`;
}

export function loadExploreGraph(origin: string): ExploreGraph {
  const expectedOrigin = origin.replace(/\/$/, "");
  const filePath = graphFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ExploreGraph;
      if (parsed && typeof parsed === "object" && parsed.screens && typeof parsed.screens === "object") {
        if (!parsed.origin || parsed.origin === expectedOrigin) {
          return {
            origin: expectedOrigin,
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
            screens: parsed.screens,
          };
        }
        return emptyExploreGraph(expectedOrigin);
      }
    } catch (err) {
      quarantineCorruptFile(filePath, "the explore graph (which control led where)", err);
    }
  }
  return emptyExploreGraph(expectedOrigin);
}

export function saveExploreGraph(graph: ExploreGraph): void {
  graph.updatedAt = new Date().toISOString();
  const filePath = graphFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(graph, null, 2), "utf-8");
}
