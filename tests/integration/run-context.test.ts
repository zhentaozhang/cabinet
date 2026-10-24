/**
 * A run must see what the team learned.
 *
 * Two tables were written and never read: `skills` (a passed exam proved a
 * procedure nobody asked the executor to follow) and
 * `profiles.preferences.rules` (reflection produced rules no prompt honoured).
 * These cases hold the read points open, including the one that decides whether
 * a skill's own tool may be used at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const seen = vi.hoisted(() => ({
  input: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/llm", () => ({
  generateArtifact: (input: Record<string, unknown>) => {
    seen.input = input;
    return Promise.resolve({
      status: "success",
      attemptId: "att_context",
      provider: "openai",
      model: "gpt-4.1-mini",
      costSource: "actual",
      draft: {
        title: "阅读 RAG 检索章节 · Mira",
        content: "## 笔记\n\n1. 先看例子\n2. 再看定义\n\n## 评分标准\n\n| 维度 | 说明 |",
        tokensIn: 100,
        tokensOut: 50,
      },
    });
  },
}));

import { db } from "@/lib/db";
import { agents, skills, steps } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/server/services/commands/tasks/run";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  seen.input = null;
});

/** Runs the seeded Coach task and insists it really reached the executor. */
async function execute(): Promise<{ runId: string }> {
  const result = await runTask("tsk_read", DEMO_USER_ID);
  if (!("runId" in result)) {
    throw new Error(`task never executed: ${JSON.stringify(result)}`);
  }
  return { runId: result.runId };
}

describe("what a run carries into the provider call", () => {
  it("passes the agent's active skills and the user's rules to the model", async () => {
    await db.insert(skills).values({
      id: "sk_active_context",
      agentId: "ag_coach",
      name: "检索评估练习设计",
      version: 2,
      steps: ["读运行", "出题", "写评分标准"],
      tools: [],
      status: "active",
      label: "active",
    });

    await runTask("tsk_read", DEMO_USER_ID);

    const skillsArg = seen.input?.skills as
      | { name: string; steps: string[] }[]
      | undefined;
    expect(skillsArg).toHaveLength(1);
    expect(skillsArg?.[0].name).toBe("检索评估练习设计");
    expect(skillsArg?.[0].steps).toEqual(["读运行", "出题", "写评分标准"]);
    // Seeded rules plus anything the workspace added, verbatim.
    expect(seen.input?.rules).toContain("讲解先给例子，再给定义");
  });

  it("leaves an unproven skill out of the prompt", async () => {
    // draft/exam skills are still being tested: their steps must not reach a
    // real task, or "the exam" would be a decoration.
    await db
      .update(skills)
      .set({ status: "draft", label: "draft" })
      .where(eq(skills.id, "sk_apprentice"));

    await runTask("tsk_read", DEMO_USER_ID);

    expect(seen.input?.skills).toEqual([]);
  });

  it("records the skill and rules it used on the run trace", async () => {
    await db.insert(skills).values({
      id: "sk_traced",
      agentId: "ag_coach",
      name: "拆小任务",
      version: 1,
      steps: ["找到超过 25 分钟的任务", "拆成两半"],
      tools: [],
      status: "active",
      label: "active",
    });

    const run = await execute();

    const trace = await db
      .select()
      .from(steps)
      .where(and(eq(steps.runId, run.runId), eq(steps.type, "context")));
    const output = trace[0]?.output as {
      skills?: string[];
      rules?: string[];
    };
    expect(output.skills).toEqual(["拆小任务"]);
    expect(output.rules).toContain("讲解先给例子，再给定义");
  });

  it("lets a skill bring a tool the agent did not declare", async () => {
    // The union happens before the grant check, so a skill cannot smuggle in a
    // permission: ag_coach really holds notes:read (seeded), and read_notes is
    // only reachable because the skill declared it.
    await db
      .update(agents)
      .set({ tools: [] })
      .where(eq(agents.id, "ag_coach"));
    await db.insert(skills).values({
      id: "sk_tool_bringer",
      agentId: "ag_coach",
      name: "读笔记再出题",
      version: 1,
      steps: ["读笔记", "出题"],
      tools: ["read_notes"],
      status: "active",
      label: "active",
    });

    const run = await execute();

    const toolStep = await db
      .select()
      .from(steps)
      .where(and(eq(steps.runId, run.runId), eq(steps.type, "tool")));
    const output = toolStep[0]?.output as {
      tool?: string | null;
      considered?: { tool: string; accepted: boolean }[];
    };
    expect(output.tool).toBe("read_notes");
    expect(
      output.considered?.find((entry) => entry.tool === "read_notes")?.accepted,
    ).toBe(true);
  });
});
