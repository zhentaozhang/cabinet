import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agentGrants, agents, tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

/**
 * Stand-in for the model call: it records what the run offered the model and
 * reports "not configured", so demo mode finishes the run with a template.
 */
const offered: Array<{ evidence?: Array<Record<string, unknown>> }> = [];

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...actual,
    generateArtifact: async (input: { evidence?: Array<Record<string, unknown>> }) => {
      offered.push(input);
      return { status: "not_configured" as const, attemptId: null };
    },
  };
});

const { runTask } = await import("@/server/services/engine");

const HTML =
  "<html><head><title>RAG 说明</title></head><body>" +
  "<nav>Jump to content Main menu</nav>" +
  "<article><p>检索增强生成把外部文档取回来，再让模型基于这些原文作答，因此每个结论都能对上出处。</p></article>" +
  "</body></html>";

beforeEach(async () => {
  offered.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(HTML, { headers: { "content-type": "text/html" } })),
  );
  await resetDb();
});

describe("fetched evidence reaches the model", () => {
  it("offers the page it just fetched, not an empty list", async () => {
    await db.update(agents).set({ tools: ["web_fetch"] }).where(eq(agents.id, "ag_coach"));
    await db.insert(agentGrants).values({
      id: "agr_test_fetch",
      agentId: "ag_coach",
      resource: "web",
      scope: "read",
      config: {},
    });
    await db
      .update(tasks)
      .set({ description: "读 https://example.com/rag 然后写 3 行笔记" })
      .where(eq(tasks.id, "tsk_read"));

    await runTask("tsk_read", DEMO_USER_ID);

    const last = offered.at(-1);
    expect(last?.evidence).toHaveLength(1);
    const [item] = last!.evidence!;
    expect(item.url).toBe("https://example.com/rag");
    expect(String(item.quote)).toContain("检索增强生成");
    expect(String(item.id)).toMatch(/^evd_/);
  });

  it("says nothing was found instead of offering an empty citation list", async () => {
    await runTask("tsk_read", DEMO_USER_ID);

    const last = offered.at(-1);
    expect(last?.evidence).toEqual([]);
  });
});
