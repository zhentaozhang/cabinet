import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { memories, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { NotFoundError } from "@/lib/domain/errors";
import { recordTaskLesson } from "@/server/services/commands/memory/task-lesson";
import { resetDb } from "../helpers/db";

const FACT_KEY = "task:tsk_read:lesson";
const OTHER = "usr_task_lesson_other";

beforeEach(async () => {
  await resetDb();
  await db.insert(users).values({
    id: OTHER,
    email: `${OTHER}@cabinet.local`,
    name: "Other",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
});

async function rows(userId = DEMO_USER_ID) {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.factKey, FACT_KEY)));
}

describe("recordTaskLesson", () => {
  it("keeps exactly one memory for repeated verdicts on the same task", async () => {
    const params = {
      userId: DEMO_USER_ID,
      taskId: "tsk_read",
      artifactId: "art_plan",
      accepted: true,
      reason: "3 行笔记齐全，含一个自己的例子。",
    } as const;

    const first = await recordTaskLesson(params);
    const second = await recordTaskLesson(params);

    expect(second.memoryId).toBe(first.memoryId);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.memoryId);
    expect(all[0].status).toBe("active");
    expect(all[0].factKey).toBe(FACT_KEY);
    expect(all[0].sourceEventId).toBe("task:tsk_read");
  });

  it("records how an accepted task got through, with its artifact as evidence", async () => {
    await recordTaskLesson({
      userId: DEMO_USER_ID,
      taskId: "tsk_read",
      artifactId: "art_plan",
      accepted: true,
      reason: "3 行笔记齐全，含一个自己的例子。",
    });

    const [row] = await rows();
    expect(row.type).toBe("procedural");
    // 领域取自任务所属目标（tsk_read -> goal_rag -> learning），不自己发明枚举值。
    expect(row.domain).toBe("learning");
    expect(row.content).toContain("通过验收");
    expect(row.content).toContain("3 行笔记齐全");
    expect(row.content).toContain("阅读 RAG 检索章节 45 分钟");
    expect(row.evidence.map((item) => item.ref)).toContain("artifact:art_plan");
    expect(row.evidence.some((item) => item.quote === "3 行笔记齐全，含一个自己的例子。")).toBe(
      true,
    );
    expect(row.value).not.toBeNull();
  });

  it("records what fell short on a rejection, and supersedes the old verdict", async () => {
    const reason = "缺少来源引用。";
    await recordTaskLesson({
      userId: DEMO_USER_ID,
      taskId: "tsk_read",
      artifactId: "art_plan",
      accepted: false,
      reason,
    });

    const [rejected] = await rows();
    expect(rejected.content).toContain("被驳回");
    expect(rejected.content).toContain("缺少来源引用");
    expect(rejected.content).not.toContain("通过验收");
    expect(rejected.status).toBe("active");

    // 同一个任务被重新验收通过：结论变了，但"一条当前结论"的约束不变——
    // 旧结论转成 superseded 历史行，当前行只有一条。
    const second = await recordTaskLesson({
      userId: DEMO_USER_ID,
      taskId: "tsk_read",
      artifactId: "art_quiz",
      accepted: true,
      reason,
    });

    const all = await rows();
    expect(all).toHaveLength(2);

    const current = all.filter((row) => row.validTo === null);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(second.memoryId);
    expect(current[0].content).toContain("通过验收");

    const retired = all.find((row) => row.id === rejected.id);
    expect(retired?.status).toBe("superseded");
    expect(retired?.supersededBy).toBe(second.memoryId);
  });

  it("refuses a task that belongs to someone else instead of writing a memory", async () => {
    await expect(
      recordTaskLesson({
        userId: OTHER,
        taskId: "tsk_read",
        artifactId: "art_plan",
        accepted: true,
        reason: "与我无关",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await rows(OTHER)).toHaveLength(0);
  });
});
