import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The frontend/backend boundary.
    //
    // Anything rendered for the user (pages, shell, widgets) may only reach the
    // backend through `@/lib/api/*` and may only know `@/contracts`. Importing a
    // service, a database client, or the engine directly is a hard error: that
    // is what makes the later extraction a deployment change instead of a
    // rewrite.
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*", "@/lib/engine", "@/lib/db", "@/lib/db/*", "@/lib/auth", "@/lib/auth/*", "drizzle-orm", "drizzle-orm/*"],
              message:
                "UI must not import server modules. Call the HTTP API via @/lib/api/server or @/lib/api/browser.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".research/**",
    ".tmp-types/**",
    ".pnpm-home/**",
  ]),
]);

export default eslintConfig;
