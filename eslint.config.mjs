import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", ".next/**", "node_modules/**", "coverage/**", "data/**", "artifacts/**"]
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        BigInt: "readonly",
        fetch: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off"
    }
  }
];
