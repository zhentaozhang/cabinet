/**
 * 人的判定，最终要落在两件事上：任务状态和审计行。
 *
 * Auditor 说"没有结论"时，任务停在 needs_review，谁也不能替它签字。这个入口是
 * 唯一能把 needs_review 带出去的地方，所以它必须：
 *   1. 要理由——一条没有理由的通过事后无法复核，也无法向以后的自己解释；
 *   2. 条件写回——两个人同时点，只能有一个落库，另一个拿到冲突而不是覆盖；
 *   3. 留审计——写下当时的判定、理由，以及被判的到底是哪份产物；
 *   4. 不动 Agent 的信任分——人的覆盖不是 Agent 的证据，正反都不算它的成绩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";

// 路由处理器会调 revalidatePath 与请求作用域的鉴权；这里只替换"框架外部世界"，
// 请求管线（CSRF、限流、幂等、错误映射）全部跑真的。
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  const { DEMO_USER_ID } = await import("@/lib/demo");
  return { ...actual, getApiUserId: async () => DEMO_USER_ID };
});

import { POST } from "@/app/api/tasks/[id]/override/route";
import { logAuditTx, verifyAuditChain } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  agents,
  artifacts,
  auditEvents,
  learningMastery,
  learningTopics,
  tasks,
} from "@/lib/db/schema";
import type { AcceptanceResult } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";
import { loadTask } from "@/server/readmodels";
import { overrideAudit } from "@/server/services/commands/tasks/override";
import { resetDb } from "../helpers/db";

const REASON = "清单里没有能判的项；我读过产物，结论成立。";

/** 审计"没有结论"时留下的那种报告：required 的人工项没人判。 */
const PENDING_REPORT: AcceptanceResult[] = [
  {
    item: { type: "manual", note: "三条要点是否真的来自会议记录", required: true },
    passed: false,
    reason: "人工核验项没有判定人。",
    undetermined: true,
  },
];

async function parkTask(
  taskId = "tsk_read",
  report: AcceptanceResult[] = PENDING_REPORT,
) {
  // 自己造数据，不等 Auditor 那条链路先落地：这个入口的前提只有"任务停在
  // needs_review"，至于它是怎么停进来的与这里无关。
  const [row] = await db
    .update(tasks)
    .set({ status: "needs_review", acceptanceReport: report })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, DEMO_USER_ID)))
    .returning();
  if (!row) throw new Error(`seed 里没有任务 ${taskId}`);
  return row;
}

async function addArtifact(taskId: string, id: string) {
  await db.insert(artifacts).values({
    id,
    taskId,
    runId: null,
    type: "markdown",
    title: "待判定的产物",
    content: "# 三条要点\n\n1. 排期\n2. 预算\n3. 风险",
  });
}

async function taskRow(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

/** 只看这个入口写下的审计行；seed 里的其它事件与它无关。 */
async function overrideRows(taskId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "audit.override"),
        eq(auditEvents.target, taskId),
      ),
    )
    .orderBy(auditEvents.seq);
}

async function agentCounters(agentId: string) {
  const [row] = await db
    .select({
      trustScore: agents.trustScore,
      successCount: agents.successCount,
      failCount: agents.failCount,
      rejectStreak: agents.rejectStreak,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  return row;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 让两个判定真的撞在同一行上。
 *
 * 直接 `Promise.all` 是不可靠的断言对象：第二个很可能在第一个提交之后才读到
 * 状态，于是拿到"不在待判定状态"（409，但原因不对）而不是"条件写回零行"。
 * 这里由测试先 `for update` 锁住任务行：两个调用都能读到 needs_review（普通
 * SELECT 不被行锁阻塞），随后一起堵在 UPDATE 上；放行后先到的那条写成功，后到
 * 的那条按 `status = 'needs_review'` 重新判定，零行命中。
 */
async function withTaskRowLock<T>(
  taskId: string,
  run: () => Array<Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from tasks where id = ${taskId} for update`);
    await gate;
  });

  await sleep(100);
  const pending = Promise.allSettled(run());
  await sleep(300);
  release();

  const settled = await pending;
  await holder;
  return settled;
}

function overrideRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/tasks/${id}/override`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(id: string, body: unknown): Promise<Response> {
  return POST(overrideRequest(id, body), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("人的判定", () => {
  it("记下判定、理由，以及被判的是哪一份产物", async () => {
    await parkTask();
    await addArtifact("tsk_read", "art_override_judged");

    const result = await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      // 理由两端的空格不该进审计：事后读到的是那句话本身。
      reason: `  ${REASON}  `,
    });

    expect(result.task.status).toBe("accepted");
    expect(result.task.acceptedAt).not.toBeNull();

    const saved = await taskRow("tsk_read");
    expect(saved.status).toBe("accepted");
    expect(saved.acceptedAt).not.toBeNull();

    const rows = await overrideRows("tsk_read");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("user");
    expect(rows[0].before).toEqual({ status: "needs_review" });
    expect(rows[0].after).toMatchObject({
      status: "accepted",
      reason: REASON,
      artifactId: "art_override_judged",
    });

    // 追加一条事件不能把哈希链写断：这条判定也要经得起事后校验。
    expect((await verifyAuditChain(DEMO_USER_ID)).ok).toBe(true);
  });

  it("判定驳回时不留下验收时间", async () => {
    await parkTask();
    await addArtifact("tsk_read", "art_override_rejected");

    const result = await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "rejected",
      reason: "要点只有三条，但没有任何一条能回溯到会议记录。",
    });

    expect(result.task.status).toBe("rejected");
    const saved = await taskRow("tsk_read");
    expect(saved.status).toBe("rejected");
    // 驳回就是没被接受，acceptedAt 必须是空的，否则"通过时间"会在驳回单上出现。
    expect(saved.acceptedAt).toBeNull();
    expect((await overrideRows("tsk_read"))[0].after).toMatchObject({
      status: "rejected",
    });
  });

  it("没有说清理由就不接受这条判定", async () => {
    await parkTask();

    // 太短、只有空白、超长，三种都不是"理由"。
    await expect(
      overrideAudit({
        taskId: "tsk_read",
        userId: DEMO_USER_ID,
        decision: "accepted",
        reason: "  还行  ",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      overrideAudit({
        taskId: "tsk_read",
        userId: DEMO_USER_ID,
        decision: "accepted",
        reason: "四个字理",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      overrideAudit({
        taskId: "tsk_read",
        userId: DEMO_USER_ID,
        decision: "accepted",
        reason: "长".repeat(501),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // 被拒的调用什么都不能留下：状态、审计行都不动。
    expect((await taskRow("tsk_read")).status).toBe("needs_review");
    expect(await overrideRows("tsk_read")).toHaveLength(0);
  });

  it("拒绝一个不在待判定状态的任务", async () => {
    // 审计已经给出结论（比如 submitted）的任务，不能被"覆盖"绕过判定流程。
    await db
      .update(tasks)
      .set({ status: "submitted" })
      .where(eq(tasks.id, "tsk_read"));

    const error = await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: REASON,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toContain("待判定");
    expect((await taskRow("tsk_read")).status).toBe("submitted");
    expect(await overrideRows("tsk_read")).toHaveLength(0);
  });

  it("两个人同时判定时只有一个落库", async () => {
    await parkTask();
    await addArtifact("tsk_read", "art_override_race");

    const settled = await withTaskRowLock("tsk_read", () => [
      overrideAudit({
        taskId: "tsk_read",
        userId: DEMO_USER_ID,
        decision: "accepted",
        reason: "两条要点都对得上会议记录，通过。",
      }),
      overrideAudit({
        taskId: "tsk_read",
        userId: DEMO_USER_ID,
        decision: "rejected",
        reason: "第三条要点没有来源，驳回。",
      }),
    ]);

    const fulfilled = settled.filter(
      (entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof overrideAudit>>> =>
        entry.status === "fulfilled",
    );
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    // 一条判定只能有一条审计行：覆盖冲突不能写成两条相反的历史。
    expect(await overrideRows("tsk_read")).toHaveLength(1);
    expect((await taskRow("tsk_read")).status).toBe(fulfilled[0].value.task.status);
  });

  it("不动执行者的信任分与成功失败计数", async () => {
    await parkTask();
    await addArtifact("tsk_read", "art_override_counters");
    const before = await agentCounters("ag_coach");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: REASON,
    });

    // 人的判定不是 Agent 的证据：通过不能给它加分，驳回也不能扣分，
    // 否则用户可以靠"亲手覆盖"把某个 Agent 的信任分刷上去。
    expect(await agentCounters("ag_coach")).toEqual(before);
  });

  it("没有产物时不编造一个 id", async () => {
    // tsk_budget 在 seed 里没有任何产物；判定仍然成立，但审计行必须写 null，
    // 而不是指向上一条别人的产物。
    await parkTask("tsk_budget");
    expect(
      await db.select().from(artifacts).where(eq(artifacts.taskId, "tsk_budget")),
    ).toHaveLength(0);

    await overrideAudit({
      taskId: "tsk_budget",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: REASON,
    });

    expect((await overrideRows("tsk_budget"))[0].after).toMatchObject({
      artifactId: null,
    });
  });

  it("不能判别人的任务", async () => {
    await parkTask();

    await expect(
      overrideAudit({
        taskId: "tsk_read",
        userId: "usr_override_other",
        decision: "accepted",
        reason: REASON,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect((await taskRow("tsk_read")).status).toBe("needs_review");
  });

  it("取最新的一份产物作为被判对象", async () => {
    await parkTask();
    await addArtifact("tsk_read", "art_override_old");
    await addArtifact("tsk_read", "art_override_new");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: REASON,
    });

    // 报告描述的是"最后一次提交的那份内容"，指错产物等于指错证据。
    const newest = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.taskId, "tsk_read"))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    expect((await overrideRows("tsk_read"))[0].after).toMatchObject({
      artifactId: newest[0].id,
    });
  });
});

describe("覆盖判定的 HTTP 入口", () => {
  it("理由太短答 400，并且不动任务", async () => {
    await parkTask();

    const response = await callRoute("tsk_read", {
      decision: "accepted",
      reason: "太短",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("validation_error");
    expect((await taskRow("tsk_read")).status).toBe("needs_review");
  });

  it("decision 只认 accepted / rejected", async () => {
    await parkTask();

    const response = await callRoute("tsk_read", {
      decision: "maybe",
      reason: REASON,
    });

    expect(response.status).toBe(400);
    expect((await taskRow("tsk_read")).status).toBe("needs_review");
  });

  it("成功时把任务写进判定结果", async () => {
    await parkTask();

    const response = await callRoute("tsk_read", {
      decision: "rejected",
      reason: "第二条要点没有来源，驳回。",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("rejected");
    expect((await taskRow("tsk_read")).status).toBe("rejected");
  });

  it("任务已经离开待判定时答 409", async () => {
    await parkTask();
    await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, "tsk_read"));

    const response = await callRoute("tsk_read", {
      decision: "rejected",
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect((await taskRow("tsk_read")).status).toBe("accepted");
  });

  it("任务不存在时答 404", async () => {
    const response = await callRoute("tsk_missing", {
      decision: "accepted",
      reason: REASON,
    });

    expect(response.status).toBe(404);
  });
});

/**
 * 人判的两个方向要分清楚：它不该动 Agent 的信任分（上面那一条），
 * 但它必须动学习者的掌握度。
 *
 * 不推进掌握度的后果很具体：到期复习题必带模型判卷项，没接模型时必然停在
 * needs_review；人判通过后任务变成 accepted，而 due_at 留在过去，同一主题
 * 每天都会被判为"到期"，SM-2 阶梯对不接模型的用户等于不存在。
 */
describe("人判推进掌握度", () => {
  const TOPIC = "闭包";

  /**
   * 造一个停在待判定的学习任务。
   *
   * 直接改行而不是跑一遍 Auditor：这个入口的前提只有"任务停在 needs_review
   * 且带着主题"，至于它是怎么停进来的与这里无关。
   */
  async function parkLearningTask(input: {
    taskId?: string;
    topicKey?: string | null;
    template?: string;
  } = {}) {
    const taskId = input.taskId ?? "tsk_read";
    await parkTask(taskId);
    await db
      .update(tasks)
      .set({
        template: input.template ?? "learning",
        topicKey: input.topicKey === undefined ? TOPIC : input.topicKey,
      })
      .where(eq(tasks.id, taskId));
  }

  async function masteryOf(topicKey: string) {
    const [row] = await db
      .select({
        attempts: learningMastery.attempts,
        correct: learningMastery.correct,
        mastery: learningMastery.mastery,
        intervalDays: learningMastery.intervalDays,
        easeFactor: learningMastery.easeFactor,
        dueAt: learningMastery.dueAt,
      })
      .from(learningMastery)
      .innerJoin(learningTopics, eq(learningTopics.id, learningMastery.topicId))
      .where(
        and(
          eq(learningMastery.userId, DEMO_USER_ID),
          eq(learningTopics.key, topicKey),
        ),
      );
    return row ?? null;
  }

  /** 明天的这个时候：排期写的是"现在 + N 天"，不是一个固定日期。 */
  function inAboutDays(days: number): number {
    return Date.now() + days * 86_400_000;
  }

  it("判定通过记一次答对，并把下次复习排到之后", async () => {
    await parkLearningTask();
    await addArtifact("tsk_read", "art_override_mastery_pass");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: "答案能自己讲清楚，判通过。",
    });

    const mastery = await masteryOf(TOPIC);
    expect(mastery).not.toBeNull();
    expect(mastery).toMatchObject({ attempts: 1, correct: 1, intervalDays: 1 });
    // 拉普拉斯平滑：(1+1)/(1+2)，不是 100%。
    expect(mastery?.mastery).toBeCloseTo(0.6667, 3);
    // 关键断言：due_at 必须离开过去，否则这个主题明天还会被判为"到期"。
    expect(mastery?.dueAt?.getTime() ?? 0).toBeGreaterThan(inAboutDays(0.9));
  });

  it("判定驳回记一次答错，间隔压回一天并下调难度系数", async () => {
    await parkLearningTask();
    await addArtifact("tsk_read", "art_override_mastery_fail");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "rejected",
      reason: "解释里把作用域链说反了，判驳回。",
    });

    const mastery = await masteryOf(TOPIC);
    expect(mastery).toMatchObject({ attempts: 1, correct: 0, intervalDays: 1 });
    expect(mastery?.mastery).toBeCloseTo(0.3333, 3);
    // 错答也要排下一次：忘掉的主题要便宜地再问一遍。
    expect(mastery?.dueAt?.getTime() ?? 0).toBeGreaterThan(inAboutDays(0.9));
  });

  it("不是学习模板的任务不写掌握度", async () => {
    // 有人手写了 topicKey，但模板不是学习任务：把它的成败记成一次复习
    // 会让间隔重复凭空跳级。
    await parkLearningTask({ template: "research", topicKey: TOPIC });
    await addArtifact("tsk_read", "art_override_mastery_other");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: "产物没问题，判通过。",
    });

    expect(await masteryOf(TOPIC)).toBeNull();
  });

  it("没有主题的任务不凭空造一个主题", async () => {
    await parkLearningTask({ topicKey: null });
    await addArtifact("tsk_read", "art_override_mastery_empty");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: "产物没问题，判通过。",
    });

    const rows = await db
      .select({ id: learningMastery.id })
      .from(learningMastery)
      .where(eq(learningMastery.userId, DEMO_USER_ID));
    expect(rows).toHaveLength(0);
  });
});

/**
 * 判定要回到它被判的那个页面上。
 *
 * 只写状态不改报告是对的（报告记的是 Auditor 判了什么），但页面若只显示
 * "需人工复核 (N 项)"，读起来就像这个人还没管过——理由得去 /review/audit 翻。
 */
describe("人判记录回到任务页", () => {
  it("已判定的任务带上判定、理由与被判产物", async () => {
    await parkTask();
    await addArtifact("tsk_read", "art_override_view");

    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "accepted",
      reason: REASON,
    });

    const page = await loadTask("tsk_read", DEMO_USER_ID);
    expect(page?.task.status).toBe("accepted");
    expect(page?.override).toMatchObject({
      decision: "accepted",
      reason: REASON,
      artifactId: "art_override_view",
    });
    // 报告没被改写：Auditor 当时判不出的那条仍然在清单里。
    expect(page?.task.acceptanceReport?.[0]?.undetermined).toBe(true);
  });

  it("没判过的任务是 null", async () => {
    const page = await loadTask("tsk_read", DEMO_USER_ID);
    expect(page?.override).toBeNull();
  });

  it("之后又追加审计事件，判定记录不会掉出窗口", async () => {
    await parkTask();
    await overrideAudit({
      taskId: "tsk_read",
      userId: DEMO_USER_ID,
      decision: "rejected",
      reason: "第二条要点没有来源，驳回。",
    });

    // 页面的审计时间线只拉最近 10 条。人判之后再记 12 条事件，
    // 如果判定是从那个窗口里筛出来的，这里就会变成 null。
    for (let index = 0; index < 12; index += 1) {
      await db.transaction(async (tx) => {
        await logAuditTx(tx, {
          userId: DEMO_USER_ID,
          actor: "user",
          action: "task.note",
          target: "tsk_read",
          before: null,
          after: { index },
        });
      });
    }

    const page = await loadTask("tsk_read", DEMO_USER_ID);
    expect(page?.override).toMatchObject({ decision: "rejected" });
  });
});
