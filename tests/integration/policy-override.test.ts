import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents, insights, policyOverrides } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { logAuditTx, verifyAuditChain } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/domain/errors";
import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";
import { getPolicyConfig, getPolicyConfigFor } from "@/lib/policy/config";
import { validateOverrideValue } from "@/lib/policy/overrides";
import {
  applyOverride,
  listOverrides,
  rollbackOverride,
} from "@/server/services/commands/policy";
import { applyInsight } from "@/server/services/commands/memory/insights";
import {
  policyProposalForRejectionRate,
  runReflection,
} from "@/server/services/commands/reflection";
import { resetDb } from "../helpers/db";

const KEY = "learning.nextTask.minWords";
const DEFAULT_MIN_WORDS = SEED_POLICY_CONFIG.learning.nextTask.minWords;

const activeRows = (userId: string, key = KEY) =>
  db
    .select()
    .from(policyOverrides)
    .where(and(eq(policyOverrides.userId, userId), eq(policyOverrides.key, key)));

const auditRows = (userId: string, action: string) =>
  db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.userId, userId), eq(auditEvents.action, action)),
    )
    .orderBy(asc(auditEvents.seq));

beforeEach(async () => {
  await resetDb();
});

describe("policy overrides change what the runtime reads", () => {
  it("applies an override that getPolicyConfigFor actually returns", async () => {
    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      DEFAULT_MIN_WORDS,
    );

    await applyOverride({ userId: DEMO_USER_ID, key: KEY, value: 40 });

    const forUser = await getPolicyConfigFor(DEMO_USER_ID);
    expect(forUser.learning.nextTask.minWords).toBe(40);
    // 只改命中的那条叶子，同组其它值不受影响。
    expect(forUser.learning.nextTask.estimateMin).toBe(
      SEED_POLICY_CONFIG.learning.nextTask.estimateMin,
    );
    // 全局默认是所有人共享的，采纳一条个人洞察不能改写它。
    expect((await getPolicyConfig()).learning.nextTask.minWords).toBe(
      DEFAULT_MIN_WORDS,
    );
  });

  it("keeps overrides per user", async () => {
    await applyOverride({ userId: DEMO_USER_ID, key: KEY, value: 40 });
    expect((await getPolicyConfigFor("usr_someone_else")).learning.nextTask.minWords).toBe(
      DEFAULT_MIN_WORDS,
    );
  });

  it("returns to the global default after a rollback", async () => {
    await applyOverride({ userId: DEMO_USER_ID, key: KEY, value: 40 });
    await rollbackOverride({ userId: DEMO_USER_ID, key: KEY });

    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      DEFAULT_MIN_WORDS,
    );
    const rows = await activeRows(DEMO_USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rolled_back");
    expect(rows[0].rolledBackAt).not.toBeNull();
    expect(await listOverrides(DEMO_USER_ID)).toHaveLength(0);
  });

  it("keeps exactly one active row when the same key is applied twice", async () => {
    const first = await applyOverride({
      userId: DEMO_USER_ID,
      key: KEY,
      value: 40,
    });
    const second = await applyOverride({
      userId: DEMO_USER_ID,
      key: KEY,
      value: 45,
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.previousValue).toBe(40);

    const rows = await activeRows(DEMO_USER_ID);
    const active = rows.filter((row) => row.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].valueJson).toBe(45);
    expect(
      active[0].appliedAt.getTime(),
    ).toBeGreaterThanOrEqual(rows[0].createdAt.getTime());
    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      45,
    );
  });
});

describe("policy override guards", () => {
  it("refuses a key outside the whitelist and writes nothing", async () => {
    await expect(
      applyOverride({ userId: DEMO_USER_ID, key: "cost.maxRunCents", value: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await listOverrides(DEMO_USER_ID)).toHaveLength(0);
    expect(await auditRows(DEMO_USER_ID, "policy.override.apply")).toHaveLength(
      0,
    );
  });

  it("refuses an out-of-range value", async () => {
    await expect(
      applyOverride({ userId: DEMO_USER_ID, key: KEY, value: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      applyOverride({
        userId: DEMO_USER_ID,
        key: "reflection.eveningHour",
        value: 24,
      }),
    ).rejects.toThrow(/reflection\.eveningHour/);
  });

  it("refuses to roll back when nothing is active", async () => {
    await expect(
      rollbackOverride({ userId: DEMO_USER_ID, key: KEY }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to roll back an override owned by another insight", async () => {
    await applyOverride({
      userId: DEMO_USER_ID,
      key: KEY,
      value: 40,
      insightId: null,
    });
    await expect(
      rollbackOverride({
        userId: DEMO_USER_ID,
        key: KEY,
        insightId: "ins_other",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("policy override audit trail", () => {
  it("records the exact value before and after", async () => {
    await applyOverride({
      userId: DEMO_USER_ID,
      key: KEY,
      value: 40,
      actor: "user",
    });
    await applyOverride({ userId: DEMO_USER_ID, key: KEY, value: 45 });

    const applies = await auditRows(DEMO_USER_ID, "policy.override.apply");
    expect(applies).toHaveLength(2);
    expect(applies[0].target).toBe(KEY);
    expect(applies[0].before).toBeNull();
    expect(applies[0].after).toMatchObject({ key: KEY, value: 40, created: true });
    expect(applies[1].before).toMatchObject({ key: KEY, value: 40 });
    expect(applies[1].after).toMatchObject({ key: KEY, value: 45, created: false });

    await rollbackOverride({ userId: DEMO_USER_ID, key: KEY });
    const rollbacks = await auditRows(DEMO_USER_ID, "policy.override.rollback");
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0].before).toMatchObject({ key: KEY, value: 45 });
    expect(rollbacks[0].after).toMatchObject({
      key: KEY,
      status: "rolled_back",
      restoredTo: DEFAULT_MIN_WORDS,
    });

    expect((await verifyAuditChain(DEMO_USER_ID)).ok).toBe(true);
  });
});

describe("accepting an insight with a set_policy change", () => {
  const seedInsight = async (value: number) => {
    await db.insert(insights).values({
      id: "ins_policy",
      userId: DEMO_USER_ID,
      claim: "验收驳回率偏高，先把下一任务的字数要求降下来。",
      rationale: "最近 7 天 4 次验收驳回 3 次。",
      confidence: 0.7,
      evidence: [{ label: "审计驳回 ×3", ref: "audit:aud_seed_6" }],
      proposedChange: {
        type: "set_policy",
        key: KEY,
        value,
        reason: "任务粒度太大，先降低最少字数要求。",
      },
      status: "proposed",
    });
  };

  it("writes a real override in the same transaction and rolls it back", async () => {
    await seedInsight(40);

    await applyInsight("ins_policy", "accept", DEMO_USER_ID);

    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      40,
    );
    const rows = await activeRows(DEMO_USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].insightId).toBe("ins_policy");

    const [accepted] = await db
      .select()
      .from(insights)
      .where(eq(insights.id, "ins_policy"));
    expect(accepted.status).toBe("applied");
    expect(accepted.beforeState).toEqual({ key: KEY, value: null });
    expect(accepted.afterState).toMatchObject({ key: KEY, value: 40 });

    await applyInsight("ins_policy", "rollback", DEMO_USER_ID);

    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      DEFAULT_MIN_WORDS,
    );
    const [rolledBack] = await activeRows(DEMO_USER_ID);
    expect(rolledBack.status).toBe("rolled_back");
    expect((await verifyAuditChain(DEMO_USER_ID)).ok).toBe(true);
  });

  it("refuses an insight whose policy value is out of range", async () => {
    await seedInsight(0);

    await expect(
      applyInsight("ins_policy", "accept", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ValidationError);

    // 事务整体回滚：洞察仍然停在 proposed，没有半套生效。
    const [insight] = await db
      .select()
      .from(insights)
      .where(eq(insights.id, "ins_policy"));
    expect(insight.status).toBe("proposed");
    expect(await listOverrides(DEMO_USER_ID)).toHaveLength(0);
  });
});

describe("reflection proposes a real policy change", () => {
  const propose = (
    rejectCount: number,
    auditCount: number,
    config = SEED_POLICY_CONFIG,
  ) =>
    policyProposalForRejectionRate({
      rejectCount,
      auditCount,
      windowDays: config.reflection.windowDays,
      config,
      latestReject: { id: "aud_seed_6", reason: "引用缺失。" },
    });

  it("proposes lowering the next task word floor when rejections dominate", () => {
    const proposal = propose(3, 4);
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedChange).toMatchObject({
      type: "set_policy",
      key: KEY,
    });
    const change = proposal!.proposedChange;
    if (change.type !== "set_policy") throw new Error("expected set_policy");
    expect(change.value).toBeLessThan(DEFAULT_MIN_WORDS);
    // 提出来就必须能落地：白名单 + 范围校验要放行。
    expect(() => validateOverrideValue(change.key, change.value)).not.toThrow();
    expect(proposal!.evidence.length).toBeGreaterThan(0);
    expect(proposal!.evidence.every((item) => Boolean(item.ref))).toBe(true);
  });

  it("stays silent when rejections are not dominant", () => {
    // 种子数据是 6 次验收里 1 次驳回：既有 reflection 测试的三段式断言靠的
    // 就是这条规则不触发。
    expect(propose(1, 6)).toBeNull();
    // 样本不足时不猜。
    expect(propose(1, 1)).toBeNull();
  });

  it("stays silent when the floor is already as low as it may go", () => {
    const config = structuredClone(SEED_POLICY_CONFIG);
    config.learning.nextTask.minWords = 1;
    expect(propose(3, 4, config)).toBeNull();
  });

  it("reaches the runtime end to end: propose → accept → applied → rollback", async () => {
    // 种子里有 5 次通过、1 次驳回，驳回率不足以触发这条规则（既有的 reflection
    // 测试也依赖它不触发）。补 5 次驳回把驳回率推过阈值。
    await db.transaction(async (tx) => {
      for (let index = 0; index < 5; index += 1) {
        await logAuditTx(tx, {
          userId: DEMO_USER_ID,
          actor: "agent:auditor",
          action: "audit.reject",
          target: `task_policy_${index}`,
          before: null,
          after: { reason: "验收标准未满足：缺少引用。" },
        });
      }
    });

    // 前面的候选（驳回改文案、晚间改时间）先出现，这条排在它们之后。
    const proposed = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const insight = await runReflection(DEMO_USER_ID);
      if (!insight) break;
      proposed.push(insight);
    }
    const policy = proposed.find(
      (insight) => insight.proposedChange.type === "set_policy",
    );
    expect(policy).toBeDefined();
    if (policy?.proposedChange.type !== "set_policy") {
      throw new Error("expected a set_policy insight");
    }
    expect(policy.proposedChange.key).toBe(KEY);
    expect(policy.proposedChange.value).toBe(48);
    expect(policy.evidence.every((item) => Boolean(item.ref))).toBe(true);

    await applyInsight(policy.id, "accept", DEMO_USER_ID);
    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      48,
    );

    // 生效之后再反思，不该再提一条"把 48 再降一次"的重复建议之外的东西 ——
    // 至少不能提出与现值相同的值。
    const again = policyProposalForRejectionRate({
      rejectCount: 6,
      auditCount: 11,
      windowDays: SEED_POLICY_CONFIG.reflection.windowDays,
      config: await getPolicyConfigFor(DEMO_USER_ID),
      latestReject: { id: "aud_seed_6", reason: "引用缺失。" },
    });
    expect(again).not.toBeNull();
    if (again?.proposedChange.type !== "set_policy") {
      throw new Error("expected a set_policy proposal");
    }
    expect(again.proposedChange.value).toBeLessThan(48);

    await applyInsight(policy.id, "rollback", DEMO_USER_ID);
    expect((await getPolicyConfigFor(DEMO_USER_ID)).learning.nextTask.minWords).toBe(
      DEFAULT_MIN_WORDS,
    );
    expect((await verifyAuditChain(DEMO_USER_ID)).ok).toBe(true);
  });
});
