import globals from "globals";

export default [
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { 
        "argsIgnorePattern": "^_", 
        "varsIgnorePattern": "^_", 
        "caughtErrorsIgnorePattern": "^(e|err|claimErr|_)$" 
      }]
    }
  }
];
