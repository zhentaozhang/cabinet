import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  capabilitySummary,
  isImplemented,
  notConnectedReason,
  planTools,
  toolPlanRegistry,
} from "@/lib/domain/tool-plan";

/**
 * 能力矩阵的回归网：注册表里声明了什么，和这个运行时能执行什么，是两件事。
 *
 * 这些断言把"18 个工具里只有 2 个真的能跑"固定下来：以后谁把某个工具标成
 * implemented，必须同时写进执行链，否则下面第 1 条会红；谁把没有执行器的工具
 * 当成已接入交给模型，route 上的能力矩阵就会开始骗人。
 */

/** 注册表里要求的 18 个工具名，逐个抄一遍而不是读 TOOL_SPECS：抄写本身就是校验。 */
const DECLARED_TOOLS = [
  "web_search",
  "web_fetch",
  "read_notes",
  "quiz",
  "write_task",
  "dispatch",
  "read_runs",
  "calendar_read",
  "ledger_read",
  "budget_veto",
  "read_artifacts",
  "audit_decision",
  "read_evidence",
  "read_all",
  "read_plan",
  "write_plan",
  "convene_council",
  "sandbox_execute",
];

describe("tool registry: implemented vs declared only", () => {
  it("declares exactly the 18 tools, each with an implemented flag", () => {
    const registry = toolPlanRegistry();
    expect(Object.keys(registry).sort()).toEqual([...DECLARED_TOOLS].sort());
    for (const tool of DECLARED_TOOLS) {
      // 缺字段不是"默认未接入"，而是注册表漏标：类型层面报错，运行期也要挡住。
      expect(typeof registry[tool].implemented, tool).toBe("boolean");
    }
  });

  it("marks only web_search and web_fetch as implemented", () => {
    const summary = capabilitySummary();
    // 这一条是本次改动的核心事实：run.ts 的确定性执行链只有这两个分支。
    expect(summary.implemented).toEqual(["web_search", "web_fetch"]);
    expect(summary.declaredOnly).toHaveLength(16);
    expect(summary.implemented.length + summary.declaredOnly.length).toBe(18);
  });

  it("never lists the same tool as both implemented and declared only", () => {
    const summary = capabilitySummary();
    const overlap = summary.implemented.filter((tool) =>
      summary.declaredOnly.includes(tool),
    );
    expect(overlap).toEqual([]);
    expect(new Set([...summary.implemented, ...summary.declaredOnly]).size).toBe(18);
  });

  it("answers isImplemented for declared, unknown and MCP tool names", () => {
    expect(isImplemented("web_search")).toBe(true);
    expect(isImplemented("web_fetch")).toBe(true);
    expect(isImplemented("read_notes")).toBe(false);
    // 未知工具不能因为"没找到所以算已接入"，也不能因为"没找到"就冒出一个新状态：
    // 它和"声明未接入"一样，都没有执行器。
    expect(isImplemented("teleport")).toBe(false);
    // MCP 工具由运行期发现，静态注册表不能替它回答"能执行"——那是 tool-loop 的答案。
    expect(isImplemented("mcp:github:search_issues")).toBe(false);
  });

  it("words a not-connected reason as declared-but-not-wired", () => {
    const reason = notConnectedReason("read_notes");
    expect(reason).toContain("read_notes");
    expect(reason).toContain("声明");
    expect(reason).toContain("未接入");
    // 没有网络请求是事实的一部分：用户最怕"是不是偷偷发出去了"。
    expect(reason).toContain("未发送");
  });

  it("keeps a separate reason for a registry/runtime mismatch", () => {
    // 注册表说能跑、执行链却没有分发：这是代码 bug，不是缺一个 connector。
    // 用同一句话描述它，就会把 bug 藏进"环境没配"里，永远查不出来。
    const mismatch = notConnectedReason("web_search");
    expect(mismatch).not.toBe(notConnectedReason("read_notes"));
    expect(mismatch).toContain("不一致");
  });
});

/**
 * planTools 的选择行为不变。这里不重抄 tests/unit/tool-plan.test.ts 的全部用例，
 * 只钉住"新增 implemented 字段没有参与授权判断"这件事：三种拒绝理由、声明顺序、
 * 通配符授权都逐字与原实现一致。
 */
/**
 * 只读源码的一条断言：run.ts 的未接入文案必须来自注册表。
 *
 * 这不是"测实现细节"，而是钉住一致性本身——两处各写一句文案，就会重新出现
 * "页面说未接入、日志说缺 connector"这种同一事实两种说法。boundary.test.ts
 * 也是用读源码的方式守住层次边界的，同样的手段在这里守住同一份事实。
 */
describe("the run step reads its reason from the registry", () => {
  it("does not hardcode the not-connected sentence in run.ts", () => {
    const source = readFileSync(
      join(process.cwd(), "src/server/services/commands/tasks/run.ts"),
      "utf8",
    );
    expect(source).toContain("notConnectedReason(toolPlan.planned.tool)");
    // 旧的英文文案把"没有执行器"说成运行期事实，既没解释也没留证据。
    expect(source).not.toContain("No executor is wired");
  });
});

describe("planTools behaviour is unchanged by the registry flag", () => {
  it("still picks the first permitted tool in declaration order", () => {
    const plan = planTools({
      tools: ["web_search", "read_notes"],
      grants: [{ resource: "notes", scope: "read" }],
      actionType: "internal",
    });
    expect(plan.planned).toEqual({
      tool: "read_notes",
      resource: "notes",
      scope: "read",
      kind: "read",
    });
    expect(plan.considered).toEqual([
      { tool: "web_search", accepted: false, reason: "missing_grant" },
      { tool: "read_notes", accepted: true },
    ]);
  });

  it("still reports a declared-only tool as permitted, not as unknown", () => {
    // 关键区分：声明未接入 ≠ 不认识。选择一个没有执行器的工具仍然是"允许"，
    // 由执行链如实写下 not_connected；若这里改成拒绝，运行日志会开始说谎。
    const plan = planTools({
      tools: ["dispatch"],
      grants: [{ resource: "task", scope: "write" }],
      actionType: "internal",
    });
    expect(plan.planned?.tool).toBe("dispatch");
    expect(isImplemented("dispatch")).toBe(false);
  });

  it("still rejects an unknown tool and an execute tool on internal work", () => {
    expect(
      planTools({
        tools: ["teleport"],
        grants: [{ resource: "*", scope: "write" }],
        actionType: "external_action",
      }).considered[0]?.reason,
    ).toBe("unknown_tool");

    expect(
      planTools({
        tools: ["sandbox_execute"],
        grants: [{ resource: "sandbox", scope: "write" }],
        actionType: "internal",
      }).considered[0]?.reason,
    ).toBe("needs_action");
  });

  it("still accepts a wildcard grant", () => {
    const plan = planTools({
      tools: ["write_plan"],
      grants: [{ resource: "*", scope: "write" }],
      actionType: "internal",
    });
    expect(plan.planned?.tool).toBe("write_plan");
  });
});
