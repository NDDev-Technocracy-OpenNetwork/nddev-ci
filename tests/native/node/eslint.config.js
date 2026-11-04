export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { TextEncoder: "readonly" },
    },
    rules: { "no-unused-vars": "error", "no-undef": "error" },
  },
];
