import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { memories, users } from "@/lib/db/schema";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

/** 独立用户：演示用户的记忆库被种子数据占着，无法控制候选池大小。 */
const OWNER = "usr_hybrid";

const NOW = new Date("2026-10-22T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

function memoryRow(input: {
  id: string;
  content: string;
  ageHours?: number;
  salience?: number;
  expiresAt?: Date | null;
}) {
  const anchor = hoursAgo(input.ageHours ?? 0);
  return {
    id: input.id,
    userId: OWNER,
    agentId: null,
    type: "semantic",
    domain: "health",
    content: input.content,
    confidence: 0.8,
    salience: input.salience ?? 0.5,
    evidence: [],
    createdAt: anchor,
    lastConfirmedAt: anchor,
    expiresAt: input.expiresAt ?? null,
  };
}

beforeEach(async () => {
  await resetDb();
  await db.insert(users).values({
    id: OWNER,
    email: "hybrid@cabinet.local",
    name: "Hybrid",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
});

describe("retrieveMemories 混合检索", () => {
  it("候选池超过粗筛上限时，最旧的相关记忆不会被无关行挤掉", async () => {
    // 205 行都更新、都不相关：按时间排序它们全部排在相关记忆前面。
    const fillers = Array.from({ length: 205 }, (_, index) =>
      memoryRow({
        id: `mem_filler_${index}`,
        content: `填充记忆 ${index}：今天喝了 ${index} 毫升水，晚上十点前睡觉。`,
        ageHours: 1,
      }),
    );
    await db.insert(memories).values(fillers);
    // 相关行最后插入（物理位置在 205 行之后）且时间最旧：
    // 旧的 LIMIT 200 没有排序，这一行根本进不了打分池。
    await db.insert(memories).values(
      memoryRow({
        id: "mem_needle",
        content: "我的 orpheus 部署清单里，第二条是回滚演练。",
        ageHours: 720,
      }),
    );

    const results = await retrieveMemories(OWNER, "orpheus", { limit: 1 });

    expect(results.map((row) => row.id)).toEqual(["mem_needle"]);
    expect(results[0]?.scores.relevance).toBe(1);
  });

  it("注入 rerank 时按它返回的 id 顺序取头部", async () => {
    const query = "晚上 运动 例子";
    const pool = await retrieveMemories(DEMO_USER_ID, query, { limit: 100 });
    expect(pool.length).toBeGreaterThanOrEqual(3);

    const reversed = await retrieveMemories(DEMO_USER_ID, query, {
      limit: 3,
      rerank: async (_query, items) =>
        [...items].reverse().map((item) => item.id),
    });

    expect(reversed.map((row) => row.id)).toEqual(
      pool
        .slice(-3)
        .reverse()
        .map((row) => row.id),
    );
  });

  it("不注入 rerank 与注入恒等 rerank 的结果完全一致", async () => {
    const query = "晚上 运动";
    const baseline = await retrieveMemories(DEMO_USER_ID, query, { limit: 3 });

    let receivedQuery = "";
    let receivedItems: Array<{ id: string; content: string }> = [];
    const identity = await retrieveMemories(DEMO_USER_ID, query, {
      limit: 3,
      rerank: async (rerankQuery, items) => {
        receivedQuery = rerankQuery;
        receivedItems = items;
        return items.map((item) => item.id);
      },
    });

    expect(identity.map((row) => row.id)).toEqual(
      baseline.map((row) => row.id),
    );
    // 钩子拿到的就是打分后的候选池，只有 id 与 content（重排模型只需要文本）
    expect(receivedQuery).toBe(query);
    expect(receivedItems.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(receivedItems[0] ?? {}).sort()).toEqual([
      "content",
      "id",
    ]);
  });

  it("rerank 只能重排：未知 id 忽略、重复 id 只认一次、没点到的按打分顺序补在后面", async () => {
    const pool = await retrieveMemories(DEMO_USER_ID, "", { limit: 100 });
    expect(pool.length).toBeGreaterThanOrEqual(3);
    const [first, second, third] = pool;

    const reranked = await retrieveMemories(DEMO_USER_ID, "", {
      limit: 3,
      rerank: async (_query, items) => [
        "mem_does_not_exist",
        items[2]?.id ?? "",
        items[0]?.id ?? "",
        items[0]?.id ?? "",
        "mem_ghost",
      ],
    });

    expect(reranked.map((row) => row.id)).toEqual([
      third?.id,
      first?.id,
      second?.id,
    ]);
  });

  it("未过期的长期记忆比同时到期的临时记忆多拿长期分", async () => {
    await db.insert(memories).values([
      memoryRow({
        id: "mem_temp",
        content: "这周临时把午休挪到 13:00。",
        ageHours: 10,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      }),
      memoryRow({
        id: "mem_stable",
        content: "这周临时把午休挪到 13:00。",
        ageHours: 10,
      }),
    ]);

    // 固定时钟：两条记忆的到期时间都相对于 NOW，用真实时钟会随运行日期漂移
    const results = await retrieveMemories(OWNER, "午休", {
      limit: 10,
      now: NOW,
    });

    expect(results.map((row) => row.id)).toEqual(["mem_stable", "mem_temp"]);
    expect(results[0]?.scores.longTerm).toBe(1);
    expect(results[1]?.scores.longTerm).toBe(0);
  });

  it("已过期的记忆不会被捞回来", async () => {
    await db.insert(memories).values(
      memoryRow({
        id: "mem_expired",
        content: "过期的 orpheus 笔记。",
        ageHours: 1,
        expiresAt: hoursAgo(1),
      }),
    );

    const results = await retrieveMemories(OWNER, "orpheus", {
      limit: 10,
      now: NOW,
    });

    expect(results).toEqual([]);
  });

  it("空查询不会崩，按重要性/近因返回", async () => {
    await db.insert(memories).values([
      memoryRow({ id: "mem_old", content: "很早以前记下的。", ageHours: 500 }),
      memoryRow({ id: "mem_new", content: "刚刚记下的。", ageHours: 0 }),
    ]);

    const results = await retrieveMemories(OWNER, "", { limit: 5 });

    expect(results.map((row) => row.id)).toEqual(["mem_new", "mem_old"]);
    expect(results.every((row) => row.scores.relevance === 0)).toBe(true);
  });

  it("超长记忆内容不影响检索", async () => {
    await db.insert(memories).values(
      memoryRow({
        id: "mem_huge",
        content: `${"长文本记忆 ".repeat(4000)}orpheus`,
        ageHours: 2,
      }),
    );

    const results = await retrieveMemories(OWNER, "orpheus", { limit: 5 });

    expect(results[0]?.id).toBe("mem_huge");
    expect(Number.isFinite(results[0]?.scores.total)).toBe(true);
  });
});
