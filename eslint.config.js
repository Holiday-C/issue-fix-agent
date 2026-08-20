import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", ".issue-fix/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "evals/**/*.ts", "vitest.config.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@anthropic-ai/sdk", "node:fs", "node:fs/*", "node:child_process"],
              message: "The agent core depends on ports, not provider or privileged adapters.",
            },
            {
              group: ["../cli/*", "../workspace/*", "../permissions/*", "../verification/*"],
              message:
                "Compose concrete infrastructure in src/cli instead of importing it into the agent core.",
            },
          ],
        },
      ],
    },
  },
);
