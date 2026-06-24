import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 78,
        lines: 80,
      },
    },
  },
});
