// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Lint rules for shoal.
 *
 * Type checking (`tsc --noEmit`) already runs in CI, so this config targets what
 * types cannot see: unused code, accidental `any`, unhandled promises in the
 * agent loops, and silently swallowed errors. `.coderabbit.yaml` asks human and
 * bot reviewers to watch for several of these by hand — the ones a linter can
 * decide are enforced here instead.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "web/dist/**",
      "coverage/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // An unused symbol after a refactor is dead weight; `_`-prefixed args are
      // the exhaustiveness-check idiom this codebase uses (`const _x: never`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // The codebase has zero `any` in non-test source today. Keep it that way.
      "@typescript-eslint/no-explicit-any": "error",
      // `catch {}` with no comment hides real failures. A comment saying why the
      // error is ignored satisfies this rule; an empty block does not.
      "no-empty": ["error", { allowEmptyCatch: false }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // Browser-side code.
    files: ["web/src/**/*.ts", "web/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        sessionStorage: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        EventSource: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Headers: "readonly",
        Blob: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLSelectElement: "readonly",
        KeyboardEvent: "readonly",
        console: "readonly",
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Node-side code.
    files: ["framework/**", "server/**", "targets/**", "bench/**", "scripts/**", "bin/**", "*.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        __dirname: "readonly",
        NodeJS: "readonly",
      },
    },
  },
  {
    // Tests mock aggressively and assert on shapes types cannot express.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
