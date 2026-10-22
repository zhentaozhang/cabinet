import { describe, expect, it } from "vitest";
import { scoreMemories } from "@/lib/memory/retrieval";

const now = new Date("2026-10-22T12:00:00Z");

const candidates = [
  {
    id: "evening",
    content: "晚上 20:00 后精力低，运动任务连续跳过。",
    salience: 0.5,
    createdAt: new Date("2026-10-22T10:00:00Z"),
    lastConfirmedAt: new Date("2026-10-22T10:00:00Z"),
  },
  {
    id: "examples",
    content: "喜欢先看具体例子，再看定义。",
    salience: 0.9,
    createdAt: new Date("2026-10-20T10:00:00Z"),
    lastConfirmedAt: new Date("2026-10-20T10:00:00Z"),
  },
  {
    id: "rerank",
    content: "rerank 概念不熟，需要对比例子。",
    salience: 0.7,
    createdAt: new Date("2026-10-21T10:00:00Z"),
    lastConfirmedAt: new Date("2026-10-21T10:00:00Z"),
  },
];

describe("memory retrieval scoring", () => {
  it("ranks a relevant memory above a high-salience irrelevant one", () => {
    const ranked = scoreMemories("晚上 运动", candidates, now);
    expect(ranked[0].id).toBe("evening");
  });

  it("uses importance when the query matches several memories", () => {
    const ranked = scoreMemories("例子", candidates, now);
    expect(ranked[0].id).toBe("examples");
  });

  it("uses importance when the query is empty", () => {
    const ranked = scoreMemories("", candidates, now);
    expect(ranked[0].id).toBe("examples");
  });

  it("returns a score breakdown", () => {
    const ranked = scoreMemories("rerank", candidates, now);
    expect(ranked[0].scores).toEqual(
      expect.objectContaining({
        recency: expect.any(Number),
        relevance: expect.any(Number),
        importance: expect.any(Number),
        total: expect.any(Number),
      }),
    );
  });
});
