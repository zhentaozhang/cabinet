import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { envPositiveInt } from "@/lib/config/env-int";
import * as schema from "./schema";

const url =
  process.env.DATABASE_URL ??
  "postgres://zhentao@localhost:5432/cabinet_dev";

const globalForDb = globalThis as unknown as {
  __cabinetPg?: ReturnType<typeof postgres>;
  __cabinetDb?: ReturnType<typeof drizzle>;
};

/**
 * `max: 1` serialised every query behind a single connection, which defeats
 * the parallel reads in `src/server/services/queries/*`. Pages issue 8-12
 * independent SELECTs, so the pool has to be wider than one.
 */
const poolMax = envPositiveInt("DATABASE_POOL_MAX", 10, 50);

const client =
  globalForDb.__cabinetPg ??
  postgres(url, {
    max: poolMax,
    prepare: false,
  });

export const db =
  globalForDb.__cabinetDb ?? drizzle(client, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__cabinetPg = client;
  globalForDb.__cabinetDb = db;
}

export { schema };
