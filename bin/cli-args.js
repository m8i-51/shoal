import { createRequire } from "module";
import { dirname, join } from "path";
import { existsSync } from "fs";

const require = createRequire(import.meta.url);

/**
 * Resolve the on-disk path to a dependency's own CLI binary (e.g. "tsx",
 * "vite"), the way npm would have symlinked it into node_modules/.bin.
 *
 * `<packageRoot>/node_modules/.bin/<packageName>` only exists when npm
 * nested that dependency directly under shoal's own node_modules — true for
 * a global install (`npm install -g`, where shoal's node_modules holds all
 * of its own deps), but NOT for a normal local install
 * (`npm install @m8i-51/shoal`), where npm hoists shared deps like tsx/vite
 * up to the *consuming project's* top-level node_modules/.bin instead.
 * Checking only the nested path and falling back to a bare command name
 * (which relies on the OS PATH — i.e. a *global* npm install of that exact
 * binary) breaks every local install with `spawn tsx ENOENT`.
 *
 * Node's own module resolution already knows where a hoisted dependency
 * landed: resolving "<packageName>/package.json" from this file walks up
 * node_modules directories exactly like `require("tsx")` would, regardless
 * of where npm actually put it. We read the package's own "bin" field so we
 * invoke the exact entry point npm would have symlinked into .bin/.
 */
export function resolveDependencyBin(packageRoot, packageName) {
  const nestedBin = join(packageRoot, "node_modules", ".bin", packageName);
  if (existsSync(nestedBin)) return nestedBin;

  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const bin = require(pkgJsonPath).bin;
    const relBin = typeof bin === "string" ? bin : bin?.[packageName];
    if (relBin) return join(dirname(pkgJsonPath), relBin);
  } catch {
    // Dependency isn't resolvable at all (shouldn't happen — it's a
    // declared dependency of shoal) — fall through to the bare name below.
  }

  return packageName;
}

/**
 * Parse global CLI flags. Remaining args (subcommand + its flags) are returned as `rest`.
 */
export function parseShoalArgs(argv) {
  const args = argv.slice(2);
  let dir;
  let envFile;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--dir" || a === "--env-file") && args[i + 1] && !args[i + 1].startsWith("-")) {
      const value = args[++i];
      if (a === "--dir") dir = value;
      else envFile = value;
      continue;
    }
    rest.push(a);
  }
  return { dir, envFile, rest };
}

export function printHelp() {
  console.log(`Usage: shoal [--dir <path>] [--env-file <path>] [command]

Commands:
  init      interactive setup — creates .env in the working directory
  config    update settings in existing .env
  doctor    check config, credentials, browser and target — makes no LLM call
  serve     web dashboard at http://localhost:4000
  triage    triage-only mode
  mcp       MCP server on stdio
  diff      focused run on PR-changed routes
  (none)    run agents from the terminal

Options:
  --dir <path>        run as if started from this directory
                      (.env, test-accounts, logs, findings, shoal.config.ts)
  --env-file <path>   load this .env instead of $PWD/.env
  -h, --help          show this help
`);
}
