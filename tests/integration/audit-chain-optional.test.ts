import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { logAudit, logAuditTx, verifyAuditChain } from "@/lib/audit";
import { db } from "@/lib/db";
import { canonicalJson } from "@/lib/ids";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("the audit chain hashes what the row actually stores", () => {
  it("keeps verifying when a payload field is undefined", async () => {
    // jsonb drops a key whose value is undefined, so the stored row has no
    // `note`. If the hash still writes "note":undefined, the chain reports
    // itself tampered the moment anyone checks it.
    await logAudit({
      userId: DEMO_USER_ID,
      actor: "user",
      action: "test.optional_field",
      target: "tsk_read",
      after: {
        status: "accepted",
        note: undefined as unknown as string,
        nested: { kept: 1, dropped: undefined as unknown as number },
      },
    });

    const chain = await verifyAuditChain(DEMO_USER_ID);
    expect(chain.ok).toBe(true);
    expect(chain.firstMismatch).toBeNull();
  });

  it("still chains events written inside a transaction", async () => {
    await db.transaction((tx) =>
      logAuditTx(tx, {
        userId: DEMO_USER_ID,
        actor: "agent:ag_coach",
        action: "test.in_transaction",
        target: "tsk_read",
        before: { status: "planned" },
        after: { status: "accepted", detail: undefined as unknown as string },
      }),
    );

    const chain = await verifyAuditChain(DEMO_USER_ID);
    expect(chain.ok).toBe(true);
  });

  it("encodes undefined the way jsonb does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined])).toBe("[1,null]");
  });
});
