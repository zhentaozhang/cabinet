import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAuthRequired, isDemoLoginEnabled, authOpenWarning } from "@/lib/auth/mode";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth mode", () => {
  test("requires auth when AUTH_REQUIRED is true", () => {
    vi.stubEnv("AUTH_REQUIRED", "true");
    expect(isAuthRequired()).toBe(true);
    expect(isDemoLoginEnabled()).toBe(false);
  });

  test("fails closed in production even without AUTH_REQUIRED", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_REQUIRED", "false");
    expect(isAuthRequired()).toBe(true);
    expect(isDemoLoginEnabled()).toBe(false);
  });

  /*
    `getApiUserId` falls back to DEMO_USER_ID only when `isAuthRequired()` is
    false. The probe used to warn on "production build without AUTH_REQUIRED",
    which is the one case where the fallback cannot happen (NODE_ENV makes auth
    required), and stayed quiet in the local build where it always happens.
  */
  test("warns about the demo fallback exactly when auth is off", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_REQUIRED", "");
    const open = authOpenWarning();
    expect(open?.code).toBe("auth.open");
    expect(open?.detail).toContain("demo user");
    expect(open?.detail).toContain("non-production");

    vi.stubEnv("AUTH_REQUIRED", "true");
    expect(authOpenWarning()).toBeNull();
  });

  test("does not call a production build open without AUTH_REQUIRED", () => {
    // A production process refuses session-less requests whatever AUTH_REQUIRED
    // says, so there is nothing to report as open.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_REQUIRED", "");
    expect(authOpenWarning()).toBeNull();
  });

  test("neither the probe nor preflight overstates the exposure", () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
    const route = read("src/app/api/health/route.ts");
    expect(route).toContain("authOpenWarning(");
    expect(route).not.toContain("everyone is the demo user");

    const preflight = read("scripts/preflight.ts");
    expect(preflight).toContain("auth.unstated");
    expect(preflight).not.toContain("every page and API would be open");
  });

  test("allows the explicit local demo combination", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_REQUIRED", "false");
    vi.stubEnv("DEMO_LOGIN_ENABLED", "true");
    expect(isAuthRequired()).toBe(false);
    expect(isDemoLoginEnabled()).toBe(true);
  });
});
