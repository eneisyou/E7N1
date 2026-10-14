import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    // Define your environment and language options
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true // Enables JSX parsing if you write React
        }
      }
    },
    rules: {
      // You can tweak logic rules here:
      "no-unused-vars": "warn",
      "no-console": "off"
      // Do NOT add formatting rules (e.g., "quotes", "semi", "indent")
      // Let Prettier handle all formatting automatically!
    }
  }
];