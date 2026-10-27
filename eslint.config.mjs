import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
// eslint-config-prettier disables every ESLint formatting rule that would
// conflict with Prettier output. It must be the LAST entry in the flat
// config array so its "off" overrides take precedence over any formatting
// rule set by `nextCoreWebVitals` / `nextTypescript` above.
import prettierConfig from "eslint-config-prettier";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Type-aware linting: required for @typescript-eslint/no-floating-promises
    // (a type-rule that consults the TypeScript type checker). Without
    // `projectService`, enabling that rule throws a "type information
    // required" config error at lint time. `projectService: true` lets
    // typescript-eslint v8 reuse the host tsconfig.json automatically.
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // === Critical TypeScript rules — enabled per P16-A ===
      // Surfaces `any` so devs opt in via explicit `// eslint-disable-next-line`
      "@typescript-eslint/no-explicit-any": "warn",
      // Catches dead parameters/imports during review instead of at runtime
      "@typescript-eslint/no-unused-vars": "warn",
      // Forbids unawaited floating promises — root cause of swallowed errors
      "@typescript-eslint/no-floating-promises": "error",

      // Other TypeScript rules — kept "off" (noise on this codebase)
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-unused-disable-directive": "off",

      // === Critical React rules — enabled per P16-A ===
      // React security rule: forbid `dangerouslySetInnerHTML` everywhere by
      // default. The only legitimate use site in this project is the
      // shadcn/ui `<ChartStyle>` primitive in `src/components/ui/chart.tsx`,
      // which inlines a sanitized CSS string into a `<style>` element (see
      // `src/lib/sanitize-html.ts` → `sanitizeCssForStyle`). That file is
      // allow-listed via the `overrides` block below. Any other
      // `dangerouslySetInnerHTML` usage should be caught at lint time so the
      // developer is forced to choose a safe alternative (DOMPurify or plain
      // `{value}` JSX interpolation, which React auto-escapes).
      "react/no-danger": "error",

      // Other React rules — kept "off" (noise on this codebase)
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react/no-unescaped-entities": "off",
      "react/display-name": "off",
      "react/prop-types": "off",
      "react-compiler/react-compiler": "off",

      // === Next.js rules — kept "off" (acceptable in this project) ===
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",

      // === Critical general JavaScript rules — enabled per P16-A ===
      // JS-side unused vars check (covers .js/.mjs/.cjs files; in .ts/.tsx
      // the @typescript-eslint variant above takes precedence).
      "no-unused-vars": "warn",
      // Force devs to remove stray console.* in committed code paths
      "no-console": "warn",
      // Strict equality: catches `==`/`!=` coercion bugs (no `null == undefined`
        // footguns, no `"0" == 0` surprises).
      "eqeqeq": "error",
      // Forbid `throw "string"` / `throw 42` — must `throw new Error(...)`
      // so stacks/errors carry a `.message` and `.stack`.
      "no-throw-literal": "error",

      // Other general JavaScript rules — kept "off" (noise on this codebase)
      "prefer-const": "off",
      "no-debugger": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-unreachable": "off",
      "no-useless-escape": "off",
    },
  },
  {
    // Per-file override: the shadcn/ui `<ChartStyle>` primitive must use
    // `dangerouslySetInnerHTML` to inline CSS into a `<style>` element (React
    // has no other API for raw CSS text content of `<style>`). The CSS
    // payload is sanitized through `sanitizeCssForStyle` before insertion,
    // so this site is the documented, defense-in-depth exception.
    files: ["src/components/ui/chart.tsx"],
    rules: {
      "react/no-danger": "off",
    },
  },
  // eslint-config-prettier — must come LAST in the flat config array so its
  // "off" settings for formatting rules override any prior config. Without
  // this entry, ESLint and Prettier would fight over spacing/quotes/semis.
  prettierConfig,
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", ".agent-skills/**"],
  },
];

export default eslintConfig;
