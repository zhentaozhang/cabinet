/**
 * 模型自选工具的循环：治理与确定性路径同一条，只是"选哪个"由模型决定。
 *
 * 这里注入 fake generate + fake 执行器，所以没有任何网络调用；
 * 数据库是真的，因为"预算/台账/step"正是要证明的东西。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";

const harness = vi.hoisted(() => ({
  artifact: null as null | ((input: never) => Promise<unknown>),
  tools: null as null | ((input: never) => Promise<unknown>),
}));

/**
 * 只替换两次模型调用的返回值，其余原样委托给真实实现。
 *
 * 不托管的话，"模型自选工具那次调用到底有没有进 runs 行"就无法在集成测试里
 * 断言——真实实现要 key，而这个用例要证明的正是记账，不是网络。
 * 没有注入时一律走真实实现，于是既有的 13 条断言逐字不变。
 */
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...actual,
    generateArtifact: async (input: never) =>
      harness.artifact ? harness.artifact(input) : actual.generateArtifact(input),
    generateWithTools: async (input: never) =>
      harness.tools ? harness.tools(input) : actual.generateWithTools(input),
  };
});

import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  retrievalCalls,
  runs,
  steps,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import type { SelectableTool } from "@/lib/domain/tool-plan";
import { getPolicyConfig } from "@/lib/policy/config";
import { runTask } from "@/server/services/commands/tasks/run";
import type {
  ModelToolExecutor,
  ModelToolGenerator,
  ModelToolRegistry,
  ToolStepRecord,
} from "@/server/services/commands/tasks/tool-loop";
import {
  MODEL_TOOL_COST_CENTS,
  runModelToolLoop,
} from "@/server/services/commands/tasks/tool-loop";
import { resetDb } from "../helpers/db";

const originalEnv = { ...process.env };

/** 与 seed 同一个时区，预留才对得上同一条预算周期行。 */
const TIMEZONE = "Asia/Shanghai";

beforeEach(async () => {
  process.env = { ...originalEnv };
  delete process.env.MODEL_TOOL_SELECTION;
  process.env.SEARCH_COST_CENTS_PER_REQUEST = "5";
  delete process.env.RETRIEVAL_WEEKLY_BUDGET_CENTS;
  vi.restoreAllMocks();
  harness.artifact = null;
  harness.tools = null;
  await resetDb();
  // retrieval_calls.run_id 有外键：循环要往台账写，就必须有一条真实的 run。
  await db.insert(runs).values({
    id: "run_model_tools",
    taskId: "tsk_research",
    agentId: "ag_research",
    status: "running",
    mode: "demo",
    sourceType: "system_event",
    startedAt: new Date(),
    runLabel: "model_tools_test",
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function collect(): { records: ToolStepRecord[]; step: (record: ToolStepRecord) => Promise<void> } {
  const records: ToolStepRecord[] = [];
  return {
    records,
    step: async (record: ToolStepRecord) => {
      records.push(record);
    },
  };
}

const WEB_SEARCH: SelectableTool = {
  tool: "web_search",
  resource: "web",
  scope: "read",
  kind: "read",
  requiresApproval: false,
};
const WEB_FETCH: SelectableTool = { ...WEB_SEARCH, tool: "web_fetch" };

const TASK = {
  title: "整理 RAG 三大范式资料",
  description: "检索、增强、生成三类范式，各给 1 个例子和 1 个来源。",
  acceptanceCriteria: "每个范式有定义、例子、来源链接。",
  actionType: "internal",
};

/** 假模型：照 SDK 的做法按顺序调用工具，并如实回报它调了什么。 */
function fakeModel(
  calls: Array<{ tool: string; input: unknown }>,
): ModelToolGenerator {
  return async ({ tools, maxSteps }) => {
    const taken: Array<{ toolName: string; input: unknown; output: unknown }> = [];
    for (const call of calls) {
      const definition = tools[call.tool];
      if (!definition) {
        // 模型点名了一个本次没提供给它的工具；循环必须自己把它记成拒绝。
        taken.push({ toolName: call.tool, input: call.input, output: null });
        continue;
      }
      const output = await definition.execute(call.input);
      taken.push({ toolName: call.tool, input: call.input, output });
    }
    return { status: "success", text: `做了 ${taken.length} 次，上限 ${maxSteps}`, steps: taken };
  };
}

function fakeExecutor(
  outcome: { status: "ok" | "not_connected"; hits: number } = { status: "ok", hits: 2 },
): { executor: ModelToolExecutor; calls: Array<{ query?: string; url?: string }> } {
  const calls: Array<{ query?: string; url?: string }> = [];
  const executor: ModelToolExecutor = async ({ input }) => {
    calls.push(input);
    return {
      status: outcome.status,
      provider: outcome.status === "ok" ? "fake" : null,
      hits: outcome.hits,
      latencyMs: 7,
      evidence:
        outcome.status === "ok"
          ? [
              {
                id: "evd_fake_1",
                url: "https://example.com/rag",
                title: "RAG 综述",
                publisher: "example.com",
                quote: "检索增强生成把外部证据放进上下文。",
                kind: "search_summary",
                retrievedAt: new Date("2026-02-01T00:00:00Z").toISOString(),
              },
            ]
          : [],
      message: outcome.status === "ok" ? null : "连接器未配置。",
    };
  };
  return { executor, calls };
}

/** seed 里带着历史 run，所以"这次运行"要看最近的那一条。 */
async function latestToolSteps(taskId: string) {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!run) return [];
  const rows = await db
    .select({ tool: steps.tool, type: steps.type, output: steps.output })
    .from(steps)
    .where(eq(steps.runId, run.id));
  return rows.filter((row) => row.type === "tool");
}

async function ledgerRows() {
  return db
    .select({
      tool: retrievalCalls.tool,
      status: retrievalCalls.status,
      charged: retrievalCalls.chargedCents,
      hits: retrievalCalls.hits,
    })
    .from(retrievalCalls)
    .orderBy(desc(retrievalCalls.createdAt));
}

/**
 * 把 ag_research 本周额度压到只剩 remainingCents。
 *
 * 只动台账行、不动 agent.budgetCents：effectiveLimitCents 取二者较小值，
 * 改 agent 只会把上限一起改小，试探不出"刚好差一次"的边界。
 */
async function setRemainingBudget(remainingCents: number) {
  const [period] = await db
    .select()
    .from(agentBudgetPeriods)
    .where(eq(agentBudgetPeriods.agentId, "ag_research"))
    .orderBy(desc(agentBudgetPeriods.periodStart))
    .limit(1);
  if (!period) throw new Error("seed 里没有 ag_research 的预算周期行");
  await db
    .update(agentBudgetPeriods)
    .set({
      reservedCents: 0,
      settledCents: Math.max(0, period.limitCents - remainingCents),
      unknownCents: 0,
      overrun: false,
    })
    .where(eq(agentBudgetPeriods.id, period.id));
}

async function reservationRows() {
  return db.select().from(agentBudgetReservations);
}

describe("runModelToolLoop", () => {
  it("executes the tools the model chose and writes one step per call", async () => {
    const sink = collect();
    const search = fakeExecutor();
    const fetch = fakeExecutor();
    const executors: Partial<Record<string, ModelToolExecutor>> = {
      web_search: search.executor,
      web_fetch: fetch.executor,
    };

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH, WEB_FETCH],
      grants: [{ resource: "web", scope: "read" }],
      executors,
      generate: fakeModel([
        { tool: "web_search", input: { query: "RAG 三大范式" } },
        { tool: "web_fetch", input: { url: "https://example.com/rag" } },
      ]),
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 2, ok: 2 });
    expect(result.evidence).toHaveLength(2);
    expect(search.calls).toEqual([{ query: "RAG 三大范式" }]);
    expect(fetch.calls).toEqual([{ url: "https://example.com/rag" }]);

    expect(sink.records).toHaveLength(2);
    expect(sink.records.map((record) => record.tool)).toEqual(["web_search", "web_fetch"]);
    expect(sink.records[0].output).toMatchObject({
      status: "ok",
      tool: "web_search",
      provider: "fake",
      attempted: true,
      // 谁选的：有了这个字段，日志能区分"确定性规划"与"模型自己挑"。
      selectedBy: "model",
    });
    expect(sink.records[0].type).toBe("tool");
    expect(sink.records[0].latency).toBe(7);
  });

  it("refuses a tool whose grant was revoked after planning", async () => {
    // allowed 是规划时的快照；执行前再查一次授权，撤销必须在这里生效。
    const sink = collect();
    const search = fakeExecutor();

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [],
      executors: { web_search: search.executor },
      generate: fakeModel([{ tool: "web_search", input: { query: "RAG" } }]),
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 0, ok: 0, evidence: [] });
    expect(search.calls).toEqual([]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].output).toMatchObject({
      status: "unauthorized",
      attempted: false,
      provider: null,
    });
    // 没有发出去的调用不能在检索台账里留下钱。
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("records a tool the model named but was never offered as not_connected", async () => {
    const sink = collect();
    const search = fakeExecutor();

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_search: search.executor },
      generate: fakeModel([{ tool: "web_fetch", input: { url: "https://example.com" } }]),
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 0, ok: 0 });
    expect(search.calls).toEqual([]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].output).toMatchObject({
      status: "not_connected",
      attempted: false,
      provider: null,
    });
  });

  it("does not search once this week's ceiling is spent", async () => {
    process.env.RETRIEVAL_WEEKLY_BUDGET_CENTS = "5";
    await db.insert(retrievalCalls).values({
      id: "rtc_spent",
      userId: DEMO_USER_ID,
      taskId: null,
      runId: null,
      tool: "web_search",
      provider: "brave",
      status: "ok",
      hits: 1,
      unitPriceCents: 5,
      chargedCents: 5,
      latencyMs: 30,
      createdAt: new Date(),
    });

    const sink = collect();
    const search = fakeExecutor();

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_search: search.executor },
      generate: fakeModel([{ tool: "web_search", input: { query: "RAG" } }]),
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 0, ok: 0 });
    // 上限在调用之前生效：执行器一次都没跑。
    expect(search.calls).toEqual([]);
    // 被预算拒掉是 budget_exceeded，不是含糊的 skipped：
    // ToolStepStatus 早就声明了这个状态，页面也有对应文案。
    expect(sink.records[0].output).toMatchObject({
      status: "budget_exceeded",
      budgetExceeded: true,
      attempted: false,
    });
    expect(String(sink.records[0].output.reason)).toContain("检索预算");

    const rows = await ledgerRows();
    // 被拒的那次仍然留痕，但金额为 0，不能凭空记一笔钱。
    expect(rows[0]).toMatchObject({ tool: "web_search", status: "skipped", charged: 0 });
    expect(rows).toHaveLength(2);
  });

  it("refuses the call when the atomic hold cannot be reserved", async () => {
    // 周检索上限（另一层预算）还没到，拦住它的必须是原子预留本身。
    await setRemainingBudget(0);

    const sink = collect();
    const search = fakeExecutor();

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_search: search.executor },
      generate: fakeModel([{ tool: "web_search", input: { query: "RAG" } }]),
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 0, ok: 0 });
    // 没有额度就没有请求：执行器一次都没跑。
    expect(search.calls).toEqual([]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].output).toMatchObject({
      status: "budget_exceeded",
      budgetExceeded: true,
      attempted: false,
      provider: null,
    });

    // 台账语义不变：被拒的外部检索记 skipped 且不计费。
    const rows = await ledgerRows();
    expect(rows[0]).toMatchObject({ tool: "web_search", status: "skipped", charged: 0 });
    // 拒绝发生在写入之前，所以没有任何预留行留下来。
    expect(await reservationRows()).toHaveLength(0);
  });

  it("cannot let two concurrent runs spend the same last allowance", async () => {
    // 只留一次计费检索的额度：两个并发 run 必须只有一个能预留成功。
    await setRemainingBudget(MODEL_TOOL_COST_CENTS);

    const search = fakeExecutor();
    const first = collect();
    const second = collect();

    const runOnce = (sink: ReturnType<typeof collect>) =>
      runModelToolLoop({
        userId: DEMO_USER_ID,
        agentId: "ag_research",
        taskId: "tsk_research",
        runId: "run_model_tools",
        timezone: TIMEZONE,
        task: TASK,
        allowed: [WEB_SEARCH],
        grants: [{ resource: "web", scope: "read" }],
        executors: { web_search: search.executor },
        generate: fakeModel([{ tool: "web_search", input: { query: "RAG" } }]),
        step: sink.step,
      });

    const [a, b] = await Promise.all([runOnce(first), runOnce(second)]);

    // 一个通过、一个被拒——"先读一次再放行"会两个都通过。
    expect([a.attempted, b.attempted].sort()).toEqual([0, 1]);
    expect(search.calls).toHaveLength(1);
    const refused = [...first.records, ...second.records].filter(
      (record) => record.output.status === "budget_exceeded",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0].output).toMatchObject({ budgetExceeded: true, attempted: false });

    // 预留行只有抢到的那一条，并且调用结束后已经结算（不会永久占着额度）。
    const held = await reservationRows();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ amountCents: MODEL_TOOL_COST_CENTS, state: "settled" });
  });

  it("still fetches a named page when the search ceiling is spent", async () => {
    // 抓取一个指名页面不按次计费，检索上限不该顺带把免费动作也停掉。
    process.env.RETRIEVAL_WEEKLY_BUDGET_CENTS = "5";
    await db.insert(retrievalCalls).values({
      id: "rtc_spent",
      userId: DEMO_USER_ID,
      taskId: null,
      runId: null,
      tool: "web_search",
      provider: "brave",
      status: "ok",
      hits: 1,
      unitPriceCents: 5,
      chargedCents: 5,
      latencyMs: 30,
      createdAt: new Date(),
    });

    const sink = collect();
    const fetch = fakeExecutor();

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_FETCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_fetch: fetch.executor },
      generate: fakeModel([{ tool: "web_fetch", input: { url: "https://example.com/rag" } }]),
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 1, ok: 1 });
    expect(fetch.calls).toHaveLength(1);
  });

  it("stops at the step ceiling and explains what it refused", async () => {
    const sink = collect();
    const search = fakeExecutor();

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_search: search.executor },
      generate: fakeModel([
        { tool: "web_search", input: { query: "a" } },
        { tool: "web_search", input: { query: "b" } },
        { tool: "web_search", input: { query: "c" } },
        { tool: "web_search", input: { query: "d" } },
      ]),
      maxSteps: 2,
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 2, ok: 2 });
    expect(search.calls).toEqual([{ query: "a" }, { query: "b" }]);
    // 两次真实调用 + 一条解释上限的 step。
    expect(sink.records).toHaveLength(3);
    expect(sink.records[2].output).toMatchObject({ status: "step_limit", limit: 2 });
    expect(sink.records[2].output.skipped).toHaveLength(2);
  });

  it("books a search as billable and a fetch as free", async () => {
    const sink = collect();
    const search = fakeExecutor();
    const fetch = fakeExecutor();

    await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH, WEB_FETCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_search: search.executor, web_fetch: fetch.executor },
      generate: fakeModel([
        { tool: "web_search", input: { query: "RAG" } },
        { tool: "web_fetch", input: { url: "https://example.com/rag" } },
      ]),
      step: sink.step,
    });

    const rows = await ledgerRows();
    const billing = new Map(rows.map((row) => [row.tool, row]));
    expect(billing.get("web_search")?.charged).toBe(5);
    expect(billing.get("web_fetch")?.charged).toBe(0);
  });

  it("records a real executor failure as a failure", async () => {
    const sink = collect();
    const { executor } = fakeExecutor({ status: "not_connected", hits: 0 });

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      executors: { web_search: executor },
      generate: fakeModel([{ tool: "web_search", input: { query: "RAG" } }]),
      step: sink.step,
    });

    // 调了但没成功：attempted 记 1、ok 记 0，状态原样上报，不写成成功。
    expect(result).toMatchObject({ attempted: 1, ok: 0 });
    expect(sink.records[0].output).toMatchObject({
      status: "not_connected",
      attempted: true,
      provider: null,
    });
  });

  it("does nothing when the Agent declares no connector tool", async () => {
    const sink = collect();
    const generator = vi.fn(fakeModel([]));

    const result = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      taskId: "tsk_read",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [],
      grants: [],
      generate: generator,
      step: sink.step,
    });

    expect(result).toMatchObject({ attempted: 0, ok: 0, evidence: [] });
    // 没有可选工具就不该花一次模型调用。
    expect(generator).not.toHaveBeenCalled();
    expect(sink.records).toHaveLength(0);
  });

  it("reports the model call's usage and model, and null when it never succeeded", async () => {
    const sink = collect();

    const measured = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      generate: async () => ({
        status: "success",
        text: "这次不需要工具。",
        steps: [],
        model: "gpt-4.1-mini",
        usage: { inputTokens: 120, outputTokens: 30 },
      }),
      step: sink.step,
    });
    // 生成器报上来的用量必须原样冒泡：上层靠它记账，丢了就等于这次调用免费。
    expect(measured).toMatchObject({
      usage: { inputTokens: 120, outputTokens: 30 },
      model: "gpt-4.1-mini",
    });

    const failed = await runModelToolLoop({
      userId: DEMO_USER_ID,
      agentId: "ag_research",
      taskId: "tsk_research",
      runId: "run_model_tools",
      timezone: TIMEZONE,
      task: TASK,
      allowed: [WEB_SEARCH],
      grants: [{ resource: "web", scope: "read" }],
      generate: async () => ({ status: "provider_error", text: "", steps: [] }),
      step: sink.step,
    });
    // 没有成功的调用就没有"谁的用量"，宁可 null 也不要编一个 0。
    expect(failed.usage).toBeNull();
    expect(failed.model).toBeNull();
  });
});

describe("MODEL_TOOL_SELECTION", () => {
  it("is off by default", () => {
    expect(process.env.MODEL_TOOL_SELECTION).toBeUndefined();
  });

  it("leaves the deterministic single tool step alone when unset", async () => {
    // 老路径的合同：一次运行恰好一条 tool step，工具来自确定性规划。
    await runTask("tsk_read", DEMO_USER_ID);

    const toolSteps = await latestToolSteps("tsk_read");
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0].tool).toBe("read_notes");
    expect((toolSteps[0].output as Record<string, unknown>).status).toBe("not_connected");
  });

  it("routes the run through the model loop when on, without faking a call", async () => {
    // 打开开关、没有模型 key：运行必须走新路径，且如实记"没有发起任何调用"。
    process.env.MODEL_TOOL_SELECTION = "on";
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));

    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);

    await runTask("tsk_research", DEMO_USER_ID);
    vi.unstubAllGlobals();

    // 确定性单工具让位：连接器一次都没被调用。
    expect(fetchSpy).not.toHaveBeenCalled();

    const toolSteps = await latestToolSteps("tsk_research");
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0].output).toMatchObject({
      status: "not_connected",
      attempted: false,
      provider: null,
      selectedBy: "model",
    });
    expect(String((toolSteps[0].output as Record<string, unknown>).reason)).toContain("模型未配置");
  });

  it("keeps the deterministic web_search step when unset", async () => {
    // 老路径要真的打到检索连接器：给一个 key，fetch 由 stub 接管。
    process.env.BRAVE_API_KEY = "test-brave-key";
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          web: { results: [{ url: "https://example.com/a", title: "A", description: "B" }] },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await runTask("tsk_research", DEMO_USER_ID);
    vi.unstubAllGlobals();

    const toolSteps = await latestToolSteps("tsk_research");
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0].tool).toBe("web_search");
    expect((toolSteps[0].output as Record<string, unknown>).status).toBe("ok");
    // 老路径没有"谁选的"这个字段：没有它才证明模型没有参与选择。
    expect((toolSteps[0].output as Record<string, unknown>).selectedBy).toBeUndefined();
  });

  it("counts the model-selection call's tokens and cost on the run row", async () => {
    // 开关打开时，模型那次调用本身也是一次真实计费调用。
    process.env.MODEL_TOOL_SELECTION = "on";
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));

    // 模型只回话、一个工具都不调：用量仍然必须记到 run 上。
    harness.tools = async () => ({
      status: "success",
      text: "这次不需要检索。",
      steps: [],
      model: "gpt-4.1-mini",
      usage: { inputTokens: 120, outputTokens: 30 },
    });

    await runTask("tsk_research", DEMO_USER_ID);

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, "tsk_research"))
      .orderBy(desc(runs.createdAt))
      .limit(1);

    // generateArtifact 那次未配置（走 demo 草稿），所以这条 run 的用量全部来自工具那次调用。
    expect(run.tokensIn).toBe(120);
    expect(run.tokensOut).toBe(30);
    const { cost: costConfig } = await getPolicyConfig();
    expect(run.costCents).toBeCloseTo(
      ((120 + 30) / 1000) * costConfig.centsPer1kTokens,
      2,
    );
    // 模型确实被调过：attempt 必须补上，否则 runs 行会声称没联系过 provider，
    // 却已经在账上花了一次钱。
    expect(run).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-mini",
      costSource: "actual",
    });
    expect(run.providerAttemptId).toMatch(/^att_/);

    // run 级预留按"确有用量"结算，而不是当成没联系过直接释放。
    const holds = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.runId, run.id));
    expect(holds).toHaveLength(1);
    expect(holds[0].state).toBe("settled");
  });

  it("adds the model call's tokens to the artifact attempt instead of replacing it", async () => {
    process.env.MODEL_TOOL_SELECTION = "on";
    await db
      .update(tasks)
      .set({ status: "planned" })
      .where(eq(tasks.id, "tsk_research"));

    harness.artifact = async () => ({
      status: "success",
      provider: "openai",
      model: "gpt-4.1",
      attemptId: "att_artifact",
      costSource: "actual",
      draft: { title: "草稿", content: "正文", tokensIn: 111, tokensOut: 222 },
    });
    harness.tools = async () => ({
      status: "success",
      text: "不需要工具。",
      steps: [],
      model: "gpt-4.1-mini",
      usage: { inputTokens: 120, outputTokens: 30 },
    });

    await runTask("tsk_research", DEMO_USER_ID);

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, "tsk_research"))
      .orderBy(desc(runs.createdAt))
      .limit(1);

    // 两次调用都算：累加，而不是互相覆盖。
    expect(run.tokensIn).toBe(111 + 120);
    expect(run.tokensOut).toBe(222 + 30);
    // 已有 attempt 的信息不能被工具那次顶掉。
    expect(run).toMatchObject({
      provider: "openai",
      model: "gpt-4.1",
      providerAttemptId: "att_artifact",
      costSource: "actual",
    });
  });
});
