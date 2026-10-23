import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEMO_USER_ID } from "@/lib/demo";
import { createTask } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  // Retrieval has to be possible for an evidence requirement to be fair.
  process.env.BRAVE_API_KEY = "test-brave-key";
});

afterEach(() => {
  delete process.env.BRAVE_API_KEY;
});

describe("research task checklist defaults", () => {
  it("gives a web-capable Agent an evidence requirement", async () => {
    const task = await createTask(
      {
        title: "对比两种 rerank 策略",
        description: "找出 cross-encoder 与 LLM rerank 的代表性来源。",
        assigneeId: "ag_research",
        auditorId: "ag_auditor",
        actionType: "internal_read",
        resource: "web",
        estimatedCostCents: 10,
        acceptanceCriteria: "结论要有可追溯来源。",
        estimateMin: 25,
      },
      DEMO_USER_ID,
    );

    expect(task.acceptanceChecklist).toEqual([
      { type: "min_evidence", value: 3, required: true },
      { type: "section", value: "来源", required: true },
    ]);
  });

  it("does not demand evidence when no search provider is configured", async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;

    const task = await createTask(
      {
        title: "对比两种 rerank 策略",
        description: "找出代表性来源。",
        assigneeId: "ag_research",
        auditorId: "ag_auditor",
        actionType: "internal_read",
        resource: "web",
        estimatedCostCents: 10,
        acceptanceCriteria: "结论要有可追溯来源。",
        estimateMin: 25,
      },
      DEMO_USER_ID,
    );

    // Without a key the run cannot persist evidence, so the requirement would
    // guarantee a rejection the user cannot fix from inside the product.
    expect(task.acceptanceChecklist).toBeNull();
  });

  it("leaves an Agent without web tools alone", async () => {
    const task = await createTask(
      {
        title: "设计练习",
        description: "出 5 道题。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "5 道题。",
        estimateMin: 20,
      },
      DEMO_USER_ID,
    );

    expect(task.acceptanceChecklist).toBeNull();
  });

  it("respects an explicit checklist", async () => {
    const task = await createTask(
      {
        title: "整理资料",
        description: "两个来源即可。",
        assigneeId: "ag_research",
        auditorId: "ag_auditor",
        actionType: "internal_read",
        resource: "web",
        estimatedCostCents: 10,
        acceptanceCriteria: "有来源。",
        acceptanceChecklist: [{ type: "min_evidence", value: 1, required: true }],
        estimateMin: 20,
      },
      DEMO_USER_ID,
    );

    expect(task.acceptanceChecklist).toEqual([
      { type: "min_evidence", value: 1, required: true },
    ]);
  });
});
