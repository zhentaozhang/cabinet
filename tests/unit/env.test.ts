import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "@/lib/env";

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cabinet-env-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const key of [
    "CABINET_ENV_TEST_ORDER",
    "CABINET_ENV_TEST_BASE",
    "CABINET_ENV_TEST_PRESET",
  ]) {
    delete process.env[key];
  }
});

describe("CLI env loader", () => {
  it("prefers .env.local over .env", () => {
    const dir = fixture({
      ".env.local": "CABINET_ENV_TEST_ORDER=local\n",
      ".env": "CABINET_ENV_TEST_ORDER=fallback\nCABINET_ENV_TEST_BASE=base\n",
    });

    loadEnv({ cwd: dir, force: true });

    expect(process.env.CABINET_ENV_TEST_ORDER).toBe("local");
    expect(process.env.CABINET_ENV_TEST_BASE).toBe("base");
  });

  it("does not override variables that are already set", () => {
    const dir = fixture({
      ".env.local": "CABINET_ENV_TEST_PRESET=from-file\n",
    });
    process.env.CABINET_ENV_TEST_PRESET = "from-process";

    loadEnv({ cwd: dir, force: true });

    expect(process.env.CABINET_ENV_TEST_PRESET).toBe("from-process");
  });
});
