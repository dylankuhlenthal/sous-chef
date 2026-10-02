import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-typecheck/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The launchers: plain JavaScript run by Node before anything is compiled.
    files: ["bin/sc", "bin/souschef"],
    languageOptions: { sourceType: "module", globals: { process: "readonly", console: "readonly", globalThis: "readonly" } },
  },
);
