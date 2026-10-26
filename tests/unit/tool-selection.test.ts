import { describe, expect, it } from "vitest";
import { planTools, selectableTools } from "@/lib/domain/tool-plan";

const web = [{ resource: "web", scope: "read" }];

/**
 * 模型可选工具列表。规则只有一条：与 planTools 同源。
 * 这里不复制授权判断，只验证"列出什么"和"planTools 会不会放行"永远一致。
 */
describe("selectableTools", () => {
  it("lists the declared tools the grants actually allow", () => {
    const tools = selectableTools({
      declaredTools: ["web_search", "web_fetch", "read_notes"],
      grants: web,
      actionType: "internal",
    });

    expect(tools.map((item) => item.tool)).toEqual(["web_search", "web_fetch"]);
    // 规格直接来自 TOOL_SPECS：resource/scope 是授权判定的输入，不能在别处重算。
    expect(tools[0]).toEqual({
      tool: "web_search",
      resource: "web",
      scope: "read",
      kind: "read",
      requiresApproval: false,
    });
  });

  it("drops a declared tool nobody granted", () => {
    const tools = selectableTools({
      declaredTools: ["web_search"],
      grants: [],
      actionType: "internal",
    });
    expect(tools).toEqual([]);
  });

  it("keeps the agent's declaration order", () => {
    const tools = selectableTools({
      declaredTools: ["web_fetch", "web_search"],
      grants: web,
      actionType: "internal",
    });
    expect(tools.map((item) => item.tool)).toEqual(["web_fetch", "web_search"]);
  });

  it("never offers an MCP tool to the model", () => {
    // 本轮 MCP 工具仍由 runMcpToolLoop 确定性驱动：它的 resource 来自服务端行，
    // 这里没有那张表，放进去只会让模型选中一个查不到授权的名字。
    const tools = selectableTools({
      declaredTools: ["mcp:ghost:ping", "web_search"],
      grants: [{ resource: "*", scope: "write" }],
      actionType: "internal",
    });
    expect(tools.map((item) => item.tool)).toEqual(["web_search"]);
  });

  it("drops an execute tool on an internal action", () => {
    const tools = selectableTools({
      declaredTools: ["sandbox_execute"],
      grants: [{ resource: "sandbox", scope: "write" }],
      actionType: "internal",
    });
    expect(tools).toEqual([]);
  });

  it("drops a revoked grant", () => {
    const tools = selectableTools({
      declaredTools: ["web_search"],
      grants: [
        { resource: "web", scope: "read", revokedAt: new Date("2026-01-01T00:00:00Z") },
      ],
      actionType: "internal",
    });
    expect(tools).toEqual([]);
  });

  it("marks writing tools as needing approval", () => {
    const tools = selectableTools({
      declaredTools: ["write_task"],
      grants: [{ resource: "task", scope: "write" }],
      actionType: "internal",
    });
    expect(tools[0]).toMatchObject({ tool: "write_task", requiresApproval: true });
  });

  it("agrees with planTools on every declared tool", () => {
    // 对照表：同一组输入，两处结论必须逐条相同。
    // 分歧就意味着"模型能看到却能调"或"模型调不到但其实被授权"。
    const cases = [
      {
        name: "web read grant",
        declaredTools: ["web_search", "web_fetch"],
        grants: web,
        actionType: "internal",
      },
      {
        name: "no grant at all",
        declaredTools: ["web_search", "read_notes"],
        grants: [],
        actionType: "internal",
      },
      {
        name: "notes only",
        declaredTools: ["web_search", "read_notes", "quiz"],
        grants: [{ resource: "notes", scope: "read" }],
        actionType: "internal",
      },
      {
        name: "read grant on a write tool",
        declaredTools: ["write_task", "read_notes"],
        grants: [{ resource: "task", scope: "read" }],
        actionType: "internal",
      },
      {
        name: "execute tool on an external action",
        declaredTools: ["sandbox_execute"],
        grants: [{ resource: "sandbox", scope: "write" }],
        actionType: "external_action",
      },
      {
        name: "wildcard grant",
        declaredTools: ["web_search", "write_plan"],
        grants: [{ resource: "*", scope: "write" }],
        actionType: "internal",
      },
      {
        name: "mcp prefix mixed in",
        declaredTools: ["mcp:ghost:ping", "web_search"],
        grants: [{ resource: "*", scope: "write" }],
        actionType: "internal",
      },
    ];

    for (const testCase of cases) {
      const offered = selectableTools(testCase).map((item) => item.tool);
      const permitted = testCase.declaredTools.filter(
        (tool) =>
          !tool.startsWith("mcp:") &&
          planTools({
            tools: [tool],
            grants: testCase.grants,
            actionType: testCase.actionType,
          }).planned !== null,
      );
      expect(offered, testCase.name).toEqual(permitted);
    }
  });
});
