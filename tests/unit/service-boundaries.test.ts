import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const SERVICES = join(process.cwd(), "src/server/services");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

function rel(file: string) {
  return relative(SERVICES, file);
}

describe("service module boundaries", () => {
  test("engine.ts is only a compatibility barrel", () => {
    const file = join(SERVICES, "engine.ts");
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n").length;

    expect(lines).toBeLessThan(80);
    expect(source).not.toMatch(/\basync function\b/);
    expect(source).not.toMatch(/\bdb\./);
    expect(source).toMatch(/export \*/);
  });

  test("no service module imports the barrel", () => {
    const violations = walk(SERVICES)
      .filter((file) => !file.endsWith("engine.ts"))
      .flatMap((file) =>
        importsOf(file)
          .filter(
            (spec) =>
              spec === "@/server/services/engine" ||
              spec.endsWith("/services/engine"),
          )
          .map((spec) => `${rel(file)} → ${spec}`),
      );

    expect(violations).toEqual([]);
  });

  test("shared and queries never depend on higher layers", () => {
    const violations: string[] = [];

    for (const file of walk(SERVICES)) {
      const layer = rel(file).split("/")[0];
      if (layer !== "shared" && layer !== "queries") continue;

      for (const spec of importsOf(file)) {
        if (
          spec.includes("/commands/") ||
          spec.startsWith("../commands/") ||
          spec.includes("/engine")
        ) {
          violations.push(`${rel(file)} → ${spec}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
