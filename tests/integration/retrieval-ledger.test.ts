import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agentGrants, agents, retrievalCalls } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { runTask } from "@/server/services/engine";
import { getWeeklyMetrics } from "@/server/services/queries/metrics";
import { resetDb } from "../helpers/db";

const originalEnv = { ...process.env };

const BRAVE_BODY = {
  web: {
    results: [
      {
        url: "https://example.com/rag",
        title: "RAG 概览",
        description: "检索增强生成先把资料取回来，再让模型据此作答。",
      },
    ],
  },
};

beforeEach(async () => {
  process.env = { ...originalEnv };
  delete process.env.TAVILY_API_KEY;
  process.env.BRAVE_API_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(BRAVE_BODY), {
      headers: { "content-type": "application/json" },
    })),
  );
  await resetDb();
  await db.update(agents).set({ tools: ["web_search"] }).where(eq(agents.id, "ag_coach"));
  await db.insert(agentGrants).values({
    id: "agr_ledger_web",
    agentId: "ag_coach",
    resource: "web",
    scope: "read",
    config: {},
  });
});

describe("retrieval ledger", () => {
  it("records the price that applied at call time", async () => {
    process.env.SEARCH_COST_CENTS_PER_REQUEST = "40";
    await runTask("tsk_read", DEMO_USER_ID);

    const rows = await db
      .select()
      .from(retrievalCalls)
      .where(eq(retrievalCalls.userId, DEMO_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("web_search");
    expect(rows[0].provider).toBe("brave");
    expect(rows[0].unitPriceCents).toBe(40);
    expect(rows[0].chargedCents).toBe(40);
  });

  it("does not re-price an old call when the deployment changes the price", async () => {
    process.env.SEARCH_COST_CENTS_PER_REQUEST = "40";
    await runTask("tsk_read", DEMO_USER_ID);
    const before = await getWeeklyMetrics(DEMO_USER_ID);

    process.env.SEARCH_COST_CENTS_PER_REQUEST = "900";
    const after = await getWeeklyMetrics(DEMO_USER_ID);

    expect(after.search.estimatedCents).toBe(before.search.estimatedCents);
    expect(after.search.estimatedCents).toBe(40);
  });

  it("reports unpriced calls instead of calling them free", async () => {
    delete process.env.SEARCH_COST_CENTS_PER_REQUEST;
    await runTask("tsk_read", DEMO_USER_ID);

    const metrics = await getWeeklyMetrics(DEMO_USER_ID);
    expect(metrics.search.requests).toBe(1);
    expect(metrics.search.unpricedRequests).toBe(1);
    expect(metrics.search.estimatedCents).toBe(0);
  });

  it("counts a call that found nothing citable, because it was still paid for", async () => {
    process.env.SEARCH_COST_CENTS_PER_REQUEST = "40";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }), {
        headers: { "content-type": "application/json" },
      })),
    );

    await runTask("tsk_read", DEMO_USER_ID);

    const rows = await db
      .select()
      .from(retrievalCalls)
      .where(
        and(
          eq(retrievalCalls.userId, DEMO_USER_ID),
          eq(retrievalCalls.status, "invalid_response"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(0);
    expect((await getWeeklyMetrics(DEMO_USER_ID)).search.estimatedCents).toBe(40);
  });
});
