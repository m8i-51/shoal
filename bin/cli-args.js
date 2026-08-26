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
