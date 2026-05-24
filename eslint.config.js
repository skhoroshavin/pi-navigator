import tseslint from "typescript-eslint";
import unslop from "eslint-plugin-unslop";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "scripts/**"],
  },
  ...tseslint.configs.recommended,
  unslop.configs.full,
  {
    settings: {
      unslop: {
        architecture: {},
      },
    },
  },
);
