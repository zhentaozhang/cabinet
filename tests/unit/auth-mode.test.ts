import { afterEach, describe, expect, test, vi } from "vitest";
import { isAuthRequired, isDemoLoginEnabled } from "@/lib/auth/mode";

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

  test("allows the explicit local demo combination", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_REQUIRED", "false");
    vi.stubEnv("DEMO_LOGIN_ENABLED", "true");
    expect(isAuthRequired()).toBe(false);
    expect(isDemoLoginEnabled()).toBe(true);
  });
});
