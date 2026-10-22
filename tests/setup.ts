import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `tests/global-setup.ts` creates a per-run database and publishes its URL.
 * Env propagation from globalSetup to workers is not guaranteed by Vitest, so
 * fall back to the handoff file whose directory is named after the parent
 * (main) process id.
 */
function resolveTestDatabaseUrl(): string {
  const fromEnv = process.env.CABINET_TEST_DATABASE_URL;
  if (fromEnv) return fromEnv;

  try {
    const handoff = path.join(
      tmpdir(),
      "cabinet-vitest",
      String(process.ppid),
      "database-url",
    );
    const fromFile = readFileSync(handoff, "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through to the shared database
  }

  return (
    process.env.DATABASE_URL_TEST ??
    "postgres://zhentao@localhost:5432/cabinet_test"
  );
}

process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.BETTER_AUTH_SECRET = "test-only-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.AUTH_REQUIRED = "false";
process.env.DEMO_MODE = "true";
