import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Orchestration entrypoints, not library code: they launch a real
        // browser / spawn a real process / drive an interactive CLI wizard,
        // and their actual logic already lives in the well-tested
        // framework/** modules they call into. A handful of unit tests do
        // import these files directly (e.g. to check a pure helper, or that
        // importing run.ts no longer launches a swarm — see M8's fix) which
        // makes v8 start instrumenting them; without this exclude, that
        // instrumentation would count their untested orchestration code
        // against the thresholds below, for files nobody intends to unit-test
        // end to end.
        "run.ts",
        "diff.ts",
        "triage-only.ts",
        "bench/index.ts",
        "bin/shoal.js",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 78,
        lines: 80,
      },
    },
  },
});
