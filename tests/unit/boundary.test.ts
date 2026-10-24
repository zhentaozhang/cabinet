import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * The frontend/backend boundary, enforced as a test.
 *
 * These assertions are what let the API move to its own deployment later: if
 * nobody can import the engine from a component, there is nothing to untangle
 * at extraction time. Lint covers the same ground for editors; this covers CI.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

function rel(file: string) {
  return file.slice(SRC.length + 1);
}

const SERVER_ONLY = [
  /^@\/server\//,
  /^@\/lib\/db(\/|$)/,
  /^@\/lib\/engine$/,
  /^@\/lib\/auth(\/|$)/,
  /^@\/lib\/setup$/,
  /^drizzle-orm(\/|$)/,
  /^pg$/,
];

describe("layer boundaries", () => {
  test("user-facing code only talks to the backend over HTTP", () => {
    const files = [
      ...walk(join(SRC, "app")).filter((f) => !rel(f).startsWith("app/api/")),
      ...walk(join(SRC, "components")),
    ];

    const violations = files.flatMap((file) =>
      importsOf(file)
        .filter((spec) => SERVER_ONLY.some((pattern) => pattern.test(spec)))
        .map((spec) => `${rel(file)} → ${spec}`),
    );

    expect(violations).toEqual([]);
  });

  test("contracts depend on nothing but zod", () => {
    const violations = walk(join(SRC, "contracts")).flatMap((file) =>
      importsOf(file)
        .filter(
          (spec) =>
            spec !== "zod" && !spec.startsWith("./") && !spec.startsWith("@/contracts"),
        )
        .map((spec) => `${rel(file)} → ${spec}`),
    );

    expect(violations).toEqual([]);
  });

  test("the backend never reaches into the UI", () => {
    const violations = walk(join(SRC, "server")).flatMap((file) =>
      importsOf(file)
        .filter((spec) => spec.startsWith("@/components") || spec.startsWith("@/app"))
        .map((spec) => `${rel(file)} → ${spec}`),
    );

    expect(violations).toEqual([]);
  });

  /**
   * `src/lib` was the one shared layer these assertions did not cover, and the
   * single violation lived exactly there: `src/lib/engine.ts:13` re-exports the
   * server implementation behind a @deprecated shim, still imported by 18
   * modules. Pin that one file as the exemption rather than leaving the whole
   * layer unguarded — any new `@/server` import from `src/lib` fails here.
   */
  const LIB_TO_SERVER_ALLOWED = new Set<string>(["lib/engine.ts"]);

  test("the shared layer never imports the server", () => {
    const violations = walk(join(SRC, "lib"))
      .filter((file) => !LIB_TO_SERVER_ALLOWED.has(rel(file)))
      .flatMap((file) =>
        importsOf(file)
          .filter((spec) => spec.startsWith("@/server/"))
          .map((spec) => `${rel(file)} → ${spec}`),
      );

    expect(violations).toEqual([]);
  });

  test("route handlers are the only backend entry point", () => {
    const routes = walk(join(SRC, "app/api"));
    expect(routes.length).toBeGreaterThan(10);
    for (const file of routes) {
      const source = readFileSync(file, "utf8");
      expect(source, `${rel(file)} should declare a handler`).toMatch(
        /export[\s\S]*\b(GET|POST|PATCH|DELETE)\b/,
      );
    }
  });
});
