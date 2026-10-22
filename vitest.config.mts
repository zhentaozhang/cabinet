import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    // The integration suite truncates and reseeds one shared Postgres database,
    // so files must never run concurrently. `singleFork` pins every file to one
    // process; `fileParallelism: false` alone is not honored by this vitest build.
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
});
