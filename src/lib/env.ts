import path from "node:path";
import { config } from "dotenv";

/**
 * Environment loader for CLI processes (drizzle-kit, seed scripts).
 *
 * Next.js already loads `.env.local` for the app, but drizzle-kit and tsx
 * scripts do not. Load `.env.local` first, then `.env`, without overriding
 * variables that are already present in the environment (CI, shell exports).
 */
let loaded = false;

export function loadEnv(options: { cwd?: string; force?: boolean } = {}): void {
  if (loaded && !options.force) return;
  loaded = true;

  const cwd = options.cwd ?? process.cwd();
  config({
    path: [".env.local", ".env"].map((file) => path.join(cwd, file)),
    override: false,
    quiet: true,
  });
}

// Importing this module is the opt-in: CLI entry points only need
// `import "@/lib/env";` before they read `process.env`.
loadEnv();
