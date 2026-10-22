import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url =
  process.env.DATABASE_URL ??
  "postgres://zhentao@localhost:5432/cabinet_dev";

const globalForDb = globalThis as unknown as {
  __cabinetPg?: ReturnType<typeof postgres>;
  __cabinetDb?: ReturnType<typeof drizzle>;
};

const client =
  globalForDb.__cabinetPg ??
  postgres(url, {
    max: 1,
    prepare: false,
  });

export const db =
  globalForDb.__cabinetDb ?? drizzle(client, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__cabinetPg = client;
  globalForDb.__cabinetDb = db;
}

export { schema };
