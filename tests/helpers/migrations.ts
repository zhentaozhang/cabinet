import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";

/**
 * Migration-step harness.
 *
 * `tests/global-setup.ts` migrates a throwaway database to head. Upgrade tests
 * additionally need to stop at a historical tag, insert legacy rows, then apply
 * the next migration — which is what this module provides.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

type JournalEntry = { idx: number; tag: string };

function journalEntries(): JournalEntry[] {
  const raw = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return [...raw.entries].sort((a, b) => a.idx - b.idx);
}

async function apply(
  client: Sql,
  entries: JournalEntry[],
): Promise<string[]> {
  const applied: string[] = [];
  for (const entry of entries) {
    const sqlText = readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8",
    );
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.unsafe(trimmed);
    }
    applied.push(entry.tag);
  }
  return applied;
}

/** Applies every migration up to and including `tag`. */
export async function applyMigrationsUpTo(
  client: Sql,
  tag: string,
): Promise<string[]> {
  const entries = journalEntries();
  const stop = entries.findIndex((entry) => entry.tag === tag);
  if (stop === -1) throw new Error(`Unknown migration tag: ${tag}`);
  return apply(client, entries.slice(0, stop + 1));
}

/** Applies the migrations strictly after `fromTag` up to and including `toTag`. */
export async function applyMigrationsFrom(
  client: Sql,
  fromTag: string,
  toTag: string,
): Promise<string[]> {
  const entries = journalEntries();
  const from = entries.findIndex((entry) => entry.tag === fromTag);
  const to = entries.findIndex((entry) => entry.tag === toTag);
  if (from === -1) throw new Error(`Unknown migration tag: ${fromTag}`);
  if (to === -1) throw new Error(`Unknown migration tag: ${toTag}`);
  if (to <= from) throw new Error(`${toTag} must come after ${fromTag}`);
  return apply(client, entries.slice(from + 1, to + 1));
}

/** Creates an empty sibling database next to the isolated test database. */
export async function createScratchDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const base =
    process.env.CABINET_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://zhentao@localhost:5432/cabinet_test";
  const baseUrl = new URL(base);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";

  const name = `${baseUrl.pathname.slice(1)}_scratch_${crypto
    .randomBytes(3)
    .toString("hex")}`;

  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const scratch = new URL(base);
  scratch.pathname = `/${name}`;

  return {
    url: scratch.toString(),
    drop: async () => {
      const cleanup = postgres(adminUrl.toString(), { max: 1, prepare: false });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
