import { beforeEach, describe, expect, it } from "vitest";
import {
  attemptScope,
  beginAttempt,
  resetAttempts,
  settleAttempt,
} from "@/lib/api/attempt";

beforeEach(() => {
  resetAttempts();
});

describe("attempt keys", () => {
  it("reuses the key while one intent is being retried", () => {
    const scope = attemptScope("POST", "/api/tasks/tsk_1/run");
    const first = beginAttempt(scope);
    settleAttempt(scope, true); // transport failure: retry the same intent
    const retry = beginAttempt(scope);
    expect(retry).toBe(first);
  });

  it("mints a new key once the intent is settled", () => {
    const scope = attemptScope("POST", "/api/tasks/tsk_1/run");
    const first = beginAttempt(scope);
    settleAttempt(scope, false); // server answered: this intent is over
    const second = beginAttempt(scope);
    expect(second).not.toBe(first);
  });

  it("does not confuse two intents with different bodies", () => {
    const approve = attemptScope("PATCH", "/api/approvals/apr_1", {
      decision: "approve",
      reason: "ok",
    });
    const reject = attemptScope("PATCH", "/api/approvals/apr_1", {
      decision: "reject",
      reason: "no",
    });
    expect(beginAttempt(approve)).not.toBe(beginAttempt(reject));
  });

  it("is order-insensitive for object keys", () => {
    expect(attemptScope("POST", "/x", { a: 1, b: 2 })).toBe(
      attemptScope("POST", "/x", { b: 2, a: 1 }),
    );
  });
});
