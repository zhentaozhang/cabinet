import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Every test run gets its own throwaway database.
 *
 * The integration suite reseeds one shared database, so two concurrent runs
 * (two agents, CI + local, a watch run plus a one-off) truncate each other's
 * rows mid-test and produce flaky failures that look like product bugs.
 * Cloning the schema into `<name>_<runId>` removes the shared state entirely.
 *
 * The URL is published through an env var, and additionally through a file
 * named after this process id, because Vitest does not promise that
 * `globalSetup` mutations of `process.env` reach the workers.
 */
const BASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgres://zhentao@localhost:5432/cabinet_test";

// Workers are forked children of this process, so `process.ppid` inside a
// worker resolves to the same directory name.
const HANDOFF_FILE = path.join(
  tmpdir(),
  "cabinet-vitest",
  String(process.pid),
  "database-url",
);

export default async function globalSetup() {
  const base = new URL(BASE_URL);
  const suffix = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const databaseName = `${base.pathname.slice(1)}_${suffix}`;

  const adminUrl = new URL(BASE_URL);
  adminUrl.pathname = "/postgres";

  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await admin.end();

  const isolated = new URL(BASE_URL);
  isolated.pathname = `/${databaseName}`;
  const isolatedUrl = isolated.toString();

  const client = postgres(isolatedUrl, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }

  process.env.CABINET_TEST_DATABASE_URL = isolatedUrl;
  process.env.DATABASE_URL = isolatedUrl;
  mkdirSync(path.dirname(HANDOFF_FILE), { recursive: true });
  writeFileSync(HANDOFF_FILE, isolatedUrl, "utf8");

  // eslint-disable-next-line no-console
  console.log(`[tests] isolated database: ${databaseName}`);

  return async () => {
    const cleanup = postgres(adminUrl.toString(), { max: 1, prepare: false });
    try {
      await cleanup.unsafe(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    } finally {
      await cleanup.end();
    }
  };
}
