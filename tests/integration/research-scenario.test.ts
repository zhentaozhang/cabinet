/**
 * The main path, end to end: a research task searches, persists what it read,
 * writes a draft that cites those rows, and the Auditor checks the format while
 * leaving credibility to the human.
 *
 * The model is stubbed at the SDK boundary on purpose — this test is about the
 * pipeline's honesty, not about a provider's wording. The stub answers with the
 * ids it was actually given, which is exactly what a real model must do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agentGrants, artifacts, evidence, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { createTask, runTask } from "@/server/services/engine";
import { auditTask } from "@/server/services/commands/tasks/audit";
import { resetDb } from "../helpers/db";

const CITED = /\[cite:(evd_[A-Za-z0-9_-]+)\]/g;

vi.mock("ai", () => ({
  generateText: async ({ prompt }: { prompt: string }) => {
    const ids = [...new Set([...prompt.matchAll(CITED)].map((match) => match[1]))];
    const rows = ids
      .slice(0, 3)
      .map((id, index) => `| 主张 ${index + 1}：检索会改变答案 | [cite:${id}] |  |`)
      .join("\n");
    return {
      text: [
        "## 结论",
        "",
        "检索增强生成在生成前引入外部文档，答案因此可以追溯。",
        "",
        "## 主张—来源",
        "",
        "| 主张 | 引用 | 是否被原文支持 |",
        "| --- | --- | --- |",
        rows,
        "",
        "## 来源",
        "",
        "见上表。",
      ].join("\n"),
      usage: { inputTokens: 120, outputTokens: 60 },
    };
  },
}));

const originalEnv = { ...process.env };

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.BRAVE_API_KEY = "test-brave-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () =>
        JSON.stringify({
          web: {
            results: [
              {
                url: "https://example.org/rag",
                title: "Retrieval-Augmented Generation",
                description: "Retrieval happens before generation, so answers cite documents.",
              },
              {
                url: "https://example.org/eval",
                title: "Evaluating RAG",
                description: "Evaluating grounded answers is still an open problem.",
              },
              {
                url: "https://example.org/hallucination",
                title: "Hallucination and grounding",
                description: "Grounding reduces but does not remove hallucination.",
              },
            ],
          },
        }),
    })),
  );
  await resetDb();
  // The seeded grants give Researcher read access to the web; a run that
  // writes an artifact from it needs write scope.
  await db.insert(agentGrants).values({
    id: "agr_research_web",
    agentId: "ag_research",
    resource: "web",
    scope: "write",
    config: {},
  });
});

describe("research scenario", () => {
  it("persists evidence, cites it, and asks the human to judge support", async () => {
    const task = await createTask(
      {
        title: "整理 RAG 的关键结论",
        description: "重点说明检索发生在生成之前。",
        acceptanceCriteria: "有结论、有来源、可核对",
        assigneeId: "ag_research",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "web",
        estimatedCostCents: 50,
        estimateMin: 30,
      },
      DEMO_USER_ID,
    );

    const run = await runTask(task.id, DEMO_USER_ID);
    expect("runId" in run).toBe(true);

    const stored = await db
      .select()
      .from(evidence)
      .where(eq(evidence.taskId, task.id));
    expect(stored.length).toBeGreaterThanOrEqual(3);

    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, task.id));
    expect(artifact.content).toContain("## 主张—来源");
    expect(artifact.content).toMatch(CITED);

    const audit = await auditTask(task.id, DEMO_USER_ID);
    // The claims table is structurally fine but its content is not machine
    // checkable, so the verdict is "needs_review" — not a free pass.
    expect(audit.decision).toBe("needs_review");

    // The report is persisted on the task, which is what the page reads.
    const [graded] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const report = graded.acceptanceReport ?? [];

    // Format is machine-checkable and enforced: three cited rows exist.
    const claimsRule = report.find((row) => row.item.type === "claims_table");
    expect(claimsRule).toBeDefined();
    expect(claimsRule?.passed).toBe(false);
    expect(claimsRule?.undetermined).toBe(true);
    expect(claimsRule?.reason).toContain("格式合格");

    // The evidence rule is a real gate, not a formality.
    const evidenceRule = report.find((row) => row.item.type === "min_evidence");
    expect(evidenceRule?.passed).toBe(true);
  });

  it("rejects a draft whose claims table cites a row that was never stored", async () => {
    const task = await createTask(
      {
        title: "整理 RAG 的关键结论",
        description: "重点说明检索发生在生成之前。",
        acceptanceCriteria: "有结论、有来源、可核对",
        assigneeId: "ag_research",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "web",
        estimatedCostCents: 50,
        estimateMin: 30,
      },
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);

    const fake = [
      "## 主张—来源",
      "",
      "| 主张 | 引用 | 是否被原文支持 |",
      "| --- | --- | --- |",
      "| 编造的结论 | [cite:evd_ghost] |  |",
      "| 另一条 | [cite:evd_ghost2] |  |",
      "| 第三条 | [cite:evd_ghost3] |  |",
    ].join("\n");
    await db
      .update(artifacts)
      .set({ content: fake })
      .where(eq(artifacts.taskId, task.id));

    const audit = await auditTask(task.id, DEMO_USER_ID);
    const [graded] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const claimsRule = (graded.acceptanceReport ?? []).find(
      (row) => row.item.type === "claims_table",
    );
    expect(claimsRule?.passed).toBe(false);
    expect(claimsRule?.undetermined).toBeFalsy();
    expect(claimsRule?.reason).toContain("引用了不存在的证据");
    expect(audit.decision).toBe("rejected");
  });
});
