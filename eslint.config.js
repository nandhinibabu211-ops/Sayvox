import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "apps/desktop/src-tauri/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    files: ["apps/desktop/src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Constitution II: provider secrets must never be referenced by the desktop client.
    files: ["apps/desktop/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/ELEVENLABS_API_KEY|OPENROUTER_API_KEY|RAZORPAY_KEY_SECRET|xi-api-key/]",
          message: "Provider keys live only in apps/api (Constitution II).",
        },
      ],
    },
  },
  prettier,
);
