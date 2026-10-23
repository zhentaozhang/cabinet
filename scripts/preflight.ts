/**
 * Deployment preflight.
 *
 * Run this in the release pipeline before the new process takes traffic. It
 * answers one question: would starting now quietly lie to users? A demo-mode
 * production deploy, an unauthenticated workspace, or a schema that lags the
 * code all pass a naive healthcheck and fail here.
 *
 *   pnpm preflight          # exits 1 on any error
 */
import "../src/lib/env";

import { count, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";

type Level = "error" | "warn" | "info";

type Finding = { level: Level; code: string; detail: string };

const findings: Finding[] = [];

function add(level: Level, code: string, detail: string) {
  findings.push({ level, code, detail });
}

const production = process.env.NODE_ENV === "production";
const allowDemoInProd = process.env.ALLOW_DEMO_IN_PROD === "true";

async function main() {
  // --- data layer -------------------------------------------------------
  if (!process.env.DATABASE_URL) {
    add("error", "database.url", "DATABASE_URL is not set.");
  } else {
    try {
      await db.execute(sql`select 1`);
      add("info", "database.reachable", "Database answered.");
    } catch (error) {
      add(
        "error",
        "database.unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (!findings.some((f) => f.code === "database.unreachable")) {
    try {
      await db.execute(sql`select 1 from run_jobs limit 1`);
      add("info", "schema.current", "run_jobs present; migrations look applied.");
    } catch {
      add(
        "error",
        "schema.behind",
        "run_jobs is missing: apply `pnpm db:migrate` before starting this build.",
      );
    }
    try {
      // A workspace that has never been seeded answers every page with an
      // error, which reads like a bug rather than like setup.
      const [row] = await db.select({ n: count() }).from(users);
      if (Number(row?.n ?? 0) === 0) {
        add("warn", "data.empty", "No users yet: run the seed or the /setup flow.");
      }
    } catch {
      /* counted above by schema check */
    }
  }

  // --- security ---------------------------------------------------------
  if (production && process.env.AUTH_REQUIRED !== "true" && !allowDemoInProd) {
    add(
      "error",
      "auth.open",
      "AUTH_REQUIRED is not \"true\" in production: every page and API would be open.",
    );
  }

  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (secret && secret.length < 32) {
    add("warn", "auth.secret_short", "BETTER_AUTH_SECRET is shorter than 32 chars.");
  }
  if (production && !secret) {
    add("error", "auth.secret_missing", "BETTER_AUTH_SECRET is not set.");
  }

  if (production && process.env.DEMO_LOGIN_ENABLED === "true" && !allowDemoInProd) {
    add(
      "error",
      "demo.login",
      "DEMO_LOGIN_ENABLED is on in production: the demo account can sign in.",
    );
  }
  if (production && process.env.DEMO_MODE === "true" && !allowDemoInProd) {
    add(
      "error",
      "demo.mode",
      "DEMO_MODE is on in production: artifacts are templates presented as work.",
    );
  }
  if (production && process.env.DEMO_RESET_ENABLED === "true" && !allowDemoInProd) {
    add("error", "demo.reset", "DEMO_RESET_ENABLED is on in production.");
  }

  // --- runtime ----------------------------------------------------------
  const execution = process.env.RUN_EXECUTION === "worker" ? "worker" : "inline";
  add("info", "execution.mode", `RUN_EXECUTION=${execution}.`);
  if (execution === "worker") {
    add(
      "warn",
      "execution.worker_required",
      "Runs are queued: this deployment needs `pnpm run:worker` (or a :once cron) to execute them.",
    );
  }

  const mail = Boolean(process.env.SMTP_HOST);
  add(
    mail ? "info" : "warn",
    "notify.channel",
    mail
      ? "SMTP configured."
      : "SMTP not configured: notices stay queued and report 未发送.",
  );

  const search = Boolean(process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY);
  add(
    search ? "info" : "warn",
    "retrieval.provider",
    search
      ? "A search provider is configured."
      : "No search provider: research runs record not_configured and cannot pass evidence rules.",
  );

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");

  for (const finding of findings) {
    const mark = finding.level === "error" ? "✗" : finding.level === "warn" ? "!" : "·";
    console.log(`${mark} [${finding.level}] ${finding.code}: ${finding.detail}`);
  }
  console.log(
    `\npreflight: ${errors.length} error(s), ${warnings.length} warning(s) — ${
      errors.length ? "REFUSING TO START" : "ok to start"
    }`,
  );

  if (errors.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[preflight] crashed", error);
    process.exit(1);
  });
