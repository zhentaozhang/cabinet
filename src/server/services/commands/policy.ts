import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { policyConfig, policyOverrides } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { ConflictError } from "@/lib/domain/errors";
import { newId } from "@/lib/ids";
import { readOverrideValue, validateOverrideValue } from "@/lib/policy/overrides";
import type { Tx } from "../shared/tx";

export const POLICY_OVERRIDE_APPLY_ACTION = "policy.override.apply";
export const POLICY_OVERRIDE_ROLLBACK_ACTION = "policy.override.rollback";

type OverrideRow = typeof policyOverrides.$inferSelect;

export type PolicyOverrideSnapshot = {
  id: string;
  key: string;
  value: number;
  previousValue: number | null;
  created: boolean;
};

/**
 * 写一条用户级策略覆盖（同一 key 只有一条 active）。
 *
 * 为什么先校验再动库：覆盖值一旦落库就会被 `getPolicyConfigFor` 直接套到
 * 运行时决策上，非法值（越界、非白名单键）必须在这里被拒，且拒绝时一个字
 * 都不写 —— 半套写入比不写更难排查。
 *
 * 为什么用 advisory lock 而不是只靠条件更新：同一 (user, key) 的并发 apply
 * 在"没有 active 行"时两条事务都想 insert，唯一索引只会让其中一条失败成
 * 500；先按 user+key 取锁能把后到的那条变成干净的 "update 已有行"。
 */
export async function applyOverrideTx(
  tx: Tx,
  input: {
    userId: string;
    key: string;
    value: unknown;
    insightId?: string | null;
    actor?: string;
  },
): Promise<PolicyOverrideSnapshot> {
  // 白名单与范围校验都在这里做：绕过 UI 直接调接口也必须被挡下。
  const value = validateOverrideValue(input.key, input.value);

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${input.userId + ":policy:" + input.key}))`,
  );

  const existing = await findActive(tx, input.userId, input.key);
  const previousValue = existing
    ? (existing.valueJson as number)
    : null;

  let id: string;
  let created: boolean;
  if (existing) {
    // 条件更新 + 检查 returning：并发期间被别人 rollback 掉时这里必须失败，
    // 而不是把一条已回滚的行悄悄改回 active。
    const [updated] = await tx
      .update(policyOverrides)
      .set({
        valueJson: value,
        appliedAt: sql`now()`,
        // 手写覆盖（insightId 为空串/未传）不该清掉原来那条洞察的归属，
        // 但显式传 null 表示"这条不再是某条洞察的产物"。
        insightId:
          input.insightId === undefined ? existing.insightId : input.insightId,
      })
      .where(
        and(
          eq(policyOverrides.id, existing.id),
          eq(policyOverrides.status, "active"),
        ),
      )
      .returning({ id: policyOverrides.id });
    if (!updated) {
      throw new ConflictError("Policy override state changed; retry.");
    }
    id = updated.id;
    created = false;
  } else {
    id = newId("pov");
    await tx.insert(policyOverrides).values({
      id,
      userId: input.userId,
      key: input.key,
      valueJson: value,
      insightId: input.insightId ?? null,
      status: "active",
    });
    created = true;
  }

  await logAuditTx(tx, {
    userId: input.userId,
    actor: input.actor ?? "user",
    action: POLICY_OVERRIDE_APPLY_ACTION,
    target: input.key,
    // before 记旧值本身（而不是"有/无"），否则事后无法回答"这条覆盖把哪个
    // 数字换掉了"。
    before: existing
      ? { key: input.key, value: existing.valueJson, status: existing.status }
      : null,
    after: {
      key: input.key,
      value,
      status: "active",
      insightId:
        input.insightId === undefined
          ? (existing?.insightId ?? null)
          : input.insightId,
      overrideId: id,
      created,
    },
  });

  return { id, key: input.key, value, previousValue, created };
}

/**
 * 回滚一条用户级覆盖：把那条 active 行标记为 rolled_back。
 *
 * 为什么留行而不删：审计链和"这条洞察被回滚过"的事实都要能回溯；删掉行之后
 * 覆盖表就看不出这条策略曾经生效过。
 */
export async function rollbackOverrideTx(
  tx: Tx,
  input: {
    userId: string;
    key: string;
    insightId?: string | null;
    actor?: string;
  },
): Promise<{ id: string; key: string; value: number; restoredTo: unknown }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${input.userId + ":policy:" + input.key}))`,
  );

  const existing = await findActive(tx, input.userId, input.key);
  if (!existing) {
    throw new ConflictError(
      `No active policy override for ${input.key}; nothing to roll back.`,
    );
  }
  // 洞察回滚只能撤销自己写的那条覆盖：否则回滚一条旧洞察会把用户后来手写
  // 的同名覆盖一起抹掉。
  if (
    input.insightId !== undefined &&
    input.insightId !== null &&
    existing.insightId !== input.insightId
  ) {
    throw new ConflictError(
      `Active policy override for ${input.key} was not created by this insight.`,
    );
  }

  const [updated] = await tx
    .update(policyOverrides)
    .set({ status: "rolled_back", rolledBackAt: sql`now()` })
    .where(
      and(
        eq(policyOverrides.id, existing.id),
        eq(policyOverrides.status, "active"),
      ),
    )
    .returning({ id: policyOverrides.id });
  if (!updated) {
    throw new ConflictError("Policy override state changed; retry.");
  }

  const restoredTo = await restoreTarget(tx, input.key);

  await logAuditTx(tx, {
    userId: input.userId,
    actor: input.actor ?? "user",
    action: POLICY_OVERRIDE_ROLLBACK_ACTION,
    target: input.key,
    before: {
      key: input.key,
      value: existing.valueJson,
      status: "active",
    },
    // restoredTo 让审计能回答"回滚之后运行时读到的到底是什么值"。
    after: {
      key: input.key,
      value: existing.valueJson,
      status: "rolled_back",
      restoredTo,
      overrideId: existing.id,
    },
  });

  return {
    id: updated.id,
    key: input.key,
    value: existing.valueJson as number,
    restoredTo,
  };
}

async function findActive(
  tx: Tx,
  userId: string,
  key: string,
): Promise<OverrideRow | undefined> {
  const [row] = await tx
    .select()
    .from(policyOverrides)
    .where(
      and(
        eq(policyOverrides.userId, userId),
        eq(policyOverrides.key, key),
        eq(policyOverrides.status, "active"),
      ),
    );
  return row;
}

/**
 * 全局默认里这条路径原来的值（回滚之后运行时实际读到的值）。
 *
 * policy_config 按根键整块存 jsonb，所以要在根行内部按"去掉根段"的相对路径
 * 取值。读不到时返回 null 而不是 undefined：审计行的 hash 是对 JSON 计算并
 * 重算校验的，undefined 会在序列化时丢键，写入与校验的哈希就不一致了。
 */
async function restoreTarget(tx: Tx, key: string): Promise<unknown> {
  const [root, ...rest] = key.split(".");
  const [row] = await tx
    .select({ valueJson: policyConfig.valueJson })
    .from(policyConfig)
    .where(eq(policyConfig.key, root));
  if (!row) return null;
  const value = readOverrideValue(row.valueJson, rest.join("."));
  return value === undefined ? null : value;
}

export async function applyOverride(input: {
  userId: string;
  key: string;
  value: unknown;
  insightId?: string | null;
  actor?: string;
}): Promise<PolicyOverrideSnapshot> {
  return db.transaction((tx) => applyOverrideTx(tx, input));
}

export async function rollbackOverride(input: {
  userId: string;
  key: string;
  insightId?: string | null;
  actor?: string;
}) {
  return db.transaction((tx) => rollbackOverrideTx(tx, input));
}

/** 当前生效的覆盖，最近应用的在前。 */
export async function listOverrides(userId: string) {
  return db
    .select()
    .from(policyOverrides)
    .where(
      and(
        eq(policyOverrides.userId, userId),
        eq(policyOverrides.status, "active"),
      ),
    )
    .orderBy(desc(policyOverrides.appliedAt));
}
