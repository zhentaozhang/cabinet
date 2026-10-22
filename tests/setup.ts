process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgres://zhentao@localhost:5432/cabinet_test";
process.env.BETTER_AUTH_SECRET = "test-only-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.AUTH_REQUIRED = "false";
