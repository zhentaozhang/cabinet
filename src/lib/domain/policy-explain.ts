import {
  decideRun,
  hasGrant,
  normalizeAction,
  type PolicyDecision,
  type PolicyEffect,
} from "./policy";

/**
 * 运行前的策略预演。
 *
 * 这一层刻意不重写判定：`explainRunPolicy` 先把同一份输入交给 `decideRun`，
 * 再把它的结论翻译成「命中哪条规则 / 为什么 / 差点什么才能放行」。
 * 之所以不复制判定，是因为复制的策略迟早会和权威实现分叉 —— 那时候预演会
 * 信誓旦旦地告诉用户「可以跑」，点下去却被拒，比没有预演更糟。
 *
 * 规则标识是从 `decideRun` 返回的理由原文回溯出来的（见 RULES 表）：理由文本
 * 就是 policy.ts 里每个分支的身份。同步义务：如果 policy.ts 改了某条 reason
 * 的措辞，必须同步改 RULES 里对应的正则；漏改的后果被限制成 `rule:
 * "unrecognized"`，effect 仍然是对的（它来自 decideRun，不来自这张表）。
 */
export type PolicyExplainInput = Parameters<typeof decideRun>[0];

/** 命中规则的稳定标识。effect 才是结论，rule 只是「哪一道关卡」的名字。 */
export type PolicyRuleId =
  | "agent_not_active"
  | "agent_lifecycle"
  | "not_assignee"
  | "auditor_cannot_run"
  | "approval_rejected"
  | "approval_pending"
  | "approval_consumed"
  | "unknown_action"
  | "missing_grant"
  | "admin_action"
  | "audit_action"
  | "internal_read"
  | "internal_write"
  | "external_action"
  | "spend"
  | "spend_threshold"
  | "requires_approval"
  | "budget_exceeded"
  | "budget_exceeded_l1"
  | "default_allow"
  | "unrecognized";

/** 这一条结论是谁改写的：用户的临时批准，还是一条常驻授权。 */
export type PolicyOverride = "standing_grant" | "approval" | null;

export type PolicyExplanation = {
  effect: PolicyEffect;
  rule: PolicyRuleId;
  /** 中文话术：为什么是这个结论。 */
  reason: string;
  /** 要变成 allow 还缺什么；已经 allow 时为空数组。 */
  missing: string[];
  /** decideRun 的原文理由，留作证据（预演页会把它折叠展示）。 */
  policyReason: string;
  override: PolicyOverride;
};

/**
 * 规则表：policy.ts 里每条 `return deny/allow/suggest/requireApproval(...)` 的
 * 措辞就是它的身份，这里按出现顺序匹配（先命中先返回，与 decideRun 的分支
 * 顺序无关，因为理由本身互不重叠）。
 */
const RULES: ReadonlyArray<{ pattern: RegExp; rule: PolicyRuleId }> = [
  { pattern: /^Agent is .+, not active\.$/, rule: "agent_not_active" },
  { pattern: /^Agent lifecycle is .+\.$/, rule: "agent_lifecycle" },
  { pattern: /^Actor is not the assignee\.$/, rule: "not_assignee" },
  {
    pattern: /^Auditor cannot execute the task they audit\.$/,
    rule: "auditor_cannot_run",
  },
  { pattern: /^Approval was rejected\.$/, rule: "approval_rejected" },
  { pattern: /^Approval is already pending\.$/, rule: "approval_pending" },
  {
    pattern: /^Approval has already been consumed\.$/,
    rule: "approval_consumed",
  },
  { pattern: /^Unknown action type: .+\.$/, rule: "unknown_action" },
  {
    pattern: /^Missing grant for resource: .+ \((read|write)\)\.$/,
    rule: "missing_grant",
  },
  { pattern: /^Admin actions are user-only\.$/, rule: "admin_action" },
  { pattern: /^Audit actions must use the audit path\.$/, rule: "audit_action" },
  { pattern: /^Read-only internal action\.$/, rule: "internal_read" },
  { pattern: /^Internal write at L2\+\.$/, rule: "internal_write" },
  { pattern: /^L1 can only suggest internal writes\.$/, rule: "internal_write" },
  { pattern: /^L1 can only suggest external actions\.$/, rule: "external_action" },
  {
    pattern: /^L2 external action requires approval\.$/,
    rule: "external_action",
  },
  { pattern: /^L1 cannot spend\.$/, rule: "spend" },
  { pattern: /^L2 spend requires approval\.$/, rule: "spend" },
  { pattern: /^Spend exceeds approval threshold\.$/, rule: "spend_threshold" },
  {
    pattern: /^Task is marked as requiring approval\.$/,
    rule: "requires_approval",
  },
  // policy.ts:458-460 的 L1 超预算分支目前不可达：level <= 1 的每种 actionType
  // 都在到达预算检查之前就 return 了。这里保留映射，是因为 reason 文本是唯一的
  // 规则身份 —— 哪天那条分支变得可达，解释层不需要跟着改。
  {
    pattern: /^Estimated spend exceeds budget at L1\.$/,
    rule: "budget_exceeded_l1",
  },
  {
    pattern: /^Estimated spend exceeds remaining budget\.$/,
    rule: "budget_exceeded",
  },
  { pattern: /^Policy allows execution\.$/, rule: "default_allow" },
];

/** 用户批准之后 decideRun 会在原理由前面加这句（policy.ts 的 gate）。 */
const APPROVED_PREFIX = "Execution approved by user. ";
/**
 * 常驻授权把理由拼成 `${standing.reason}：${原理由}`，分隔符是全角冒号。
 * 理由原文里的冒号都是 ASCII 的 ": "（如 "Unknown action type: x."），
 * 所以按全角冒号切开不会切错位置。
 */
const STANDING_JOINER = "：";

function identifyRule(innerReason: string): PolicyRuleId {
  for (const entry of RULES) {
    if (entry.pattern.test(innerReason)) return entry.rule;
  }
  return "unrecognized";
}

/** 只做 ¥X.XX：domain 层不引 UI 工具（src/lib/format.ts 的 money 会带进 clsx）。 */
function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function describe(
  rule: PolicyRuleId,
  effect: PolicyEffect,
  input: PolicyExplainInput,
): string {
  const { actor, task } = input;
  switch (rule) {
    case "agent_not_active":
      return `Agent 的状态是 ${actor.status}，不在岗就不能执行。`;
    case "agent_lifecycle":
      return `Agent 的生命周期是 ${actor.lifecycleStage}，还没到能独立执行的阶段。`;
    case "not_assignee":
      return `这条任务的执行者不是这个 Agent（${actor.id}）。`;
    case "auditor_cannot_run":
      return "这个 Agent 是这条任务的验收方，执行和验收不能是同一个。";
    case "approval_rejected":
      return "你已经驳回过这次执行，驳回是硬信号，点运行不会翻案。";
    case "approval_pending":
      return "已经有一条待处理的审批，等它出结论之前不会重复发起。";
    case "approval_consumed":
      return "那条批准已经被用掉了：一次批准只抵扣一次执行。";
    case "unknown_action":
      return `动作类型 ${task.actionType} 不在策略认识的范围里。`;
    case "missing_grant": {
      const scope = normalizeAction(task.actionType) === "internal_read" ? "read" : "write";
      return `这个 Agent 没有 ${task.resource} 的 ${scope} 授权。`;
    }
    case "admin_action":
      return "admin 类动作只能由你本人做，不交给 Agent。";
    case "audit_action":
      return "审计动作必须走 audit 入口，运行入口不执行审计。";
    case "internal_read":
      return "只读的内部动作，没有需要审批的地方。";
    case "internal_write":
      return effect === "allow"
        ? "内部写，Agent 的自治等级已经到 L2，可以直接执行。"
        : "内部写，但 L1 只能提建议，不能自己动手。";
    case "external_action":
      if (effect === "suggest") return "外部动作，L1 只能提议，要你点头才会发出去。";
      if (effect === "require_approval") return "L2 的外部动作，需要你先批准一次。";
      return "外部动作，这一次已经放行。";
    case "spend":
      if (effect === "deny") return "L1 不允许花钱。";
      if (effect === "require_approval") return "L2 的花费需要你先批准一次。";
      return "这笔花费已经放行。";
    case "spend_threshold": {
      const threshold =
        task.approvalThresholdCents ?? input.config.budget.approvalThresholdCents;
      return `预估花费 ${yuan(task.estimatedCostCents)} 超过审批阈值 ${yuan(threshold)}。`;
    }
    case "requires_approval":
      return "这条任务被标记为必须审批。";
    case "budget_exceeded":
    case "budget_exceeded_l1": {
      const { limitCents, spentCents } = input.budget;
      return `本周预算 ${yuan(limitCents)} 已用 ${yuan(spentCents)}，再花 ${yuan(
        task.estimatedCostCents,
      )} 就超了。`;
    }
    case "default_allow":
      return "结构、授权、自治等级、预算都没拦，策略全部放行。";
    case "unrecognized":
      return `策略判定为 ${effect}（这条理由还没有对应的中文解释，原文见下）。`;
  }
}

function missingFor(
  rule: PolicyRuleId,
  effect: PolicyEffect,
  input: PolicyExplainInput,
): string[] {
  // 已经放行就没有「还缺什么」；返回空数组而不是一句「无需操作」，
  // 让调用方可以直接按长度决定要不要渲染这一段。
  if (effect === "allow") return [];

  const { actor, task } = input;
  const deficit = Math.max(
    0,
    input.budget.spentCents + task.estimatedCostCents - input.budget.limitCents,
  );

  switch (rule) {
    case "internal_write":
      return ["把该 Agent 的自治等级提到 L2（L1 只能建议，不能自己写）"];
    case "external_action":
      return effect === "suggest"
        ? ["把该 Agent 的自治等级提到 L2"]
        : ["需要你为这次执行点一次「批准」（想免掉每次都问，可以改成常驻授权）"];
    case "spend":
      return ["需要你为这笔花费点一次「批准」"];
    case "spend_threshold": {
      const threshold =
        task.approvalThresholdCents ?? input.config.budget.approvalThresholdCents;
      return [
        "需要你为超出阈值的这笔花费点一次「批准」",
        `或者把这笔的审批阈值从 ${yuan(threshold)} 调到 ${yuan(
          task.estimatedCostCents,
        )} 以上`,
      ];
    }
    case "requires_approval":
      return ["需要你点一次「批准」"];
    case "budget_exceeded":
      return [
        `给该 Agent 提高周预算：现在还差 ${yuan(deficit)}`,
        "预算不足靠批准解决不了，即使批准也会被这条挡住",
      ];
    case "budget_exceeded_l1":
      return [
        `给该 Agent 提高周预算：现在还差 ${yuan(deficit)}`,
        "L1 即使被批准也不能超预算执行，需要同时把自治等级提到 L2",
      ];
    case "missing_grant": {
      const scope = normalizeAction(task.actionType) === "internal_read" ? "read" : "write";
      return hasGrant(input.grants, task.resource, "read")
        ? [
            `给该 Agent 授予 ${task.resource} 的 ${scope} 授权`,
            "它现在只有 read 级别的授权，不够这条动作",
          ]
        : [
            `给该 Agent 授予 ${task.resource} 的 ${scope} 授权`,
            "当前没有任何覆盖这个资源的有效授权（撤销过的不算）",
          ];
    }
    case "admin_action":
      return ["admin 类动作只能由你在界面上直接做，没有可以给 Agent 的授权"];
    case "audit_action":
      return ["审计要走验收入口，把 actionType 换成它真正要做的事"];
    case "agent_not_active":
      return [`把 Agent 状态改回 active（当前是 ${actor.status}）`];
    case "agent_lifecycle":
      return [
        `先让它走完入职/毕业流程，生命周期进入 active（当前是 ${actor.lifecycleStage}）`,
      ];
    case "not_assignee":
      return ["把这条任务的执行者改成这个 Agent，或者换一条它名下的任务"];
    case "auditor_cannot_run":
      return ["换一个 Agent 执行：执行者和验收者必须是两个"];
    case "approval_rejected":
      return ["重新发起一条审批（已驳回的那条不会因为再点运行而通过）"];
    case "approval_pending":
      return ["等当前这条审批出结论，或者先去把它处理掉"];
    case "approval_consumed":
      return ["重新发起并批准一条新的审批"];
    case "unknown_action":
      return [
        `把 actionType 改成已知类型（当前是 ${task.actionType}；可选 internal / external / spend / audit / admin）`,
      ];
    case "default_allow":
    case "internal_read":
    case "unrecognized":
      return [];
  }
}

export function explainRunPolicy(input: PolicyExplainInput): PolicyExplanation {
  const decision = decideRun(input);
  const { rule, override, prefixReason } = unwrap(decision);
  const base = describe(rule, decision.effect, input);

  // 覆盖不是「另一条规则」：命中规则还是原来那条，只是用户这一次的批准 /
  // 一条常驻授权把它从 require_approval 抬成了 allow。话术必须同时说清这两件事。
  const reason =
    override === "standing_grant"
      ? `${prefixReason}；${base}`
      : override === "approval"
        ? `${base}（你已经批准了这一次，这条批准只会用一次）`
        : base;

  return {
    effect: decision.effect,
    rule,
    reason,
    missing: missingFor(rule, decision.effect, input),
    policyReason: decision.reason,
    override,
  };
}

/** 把 gate 包装出来的理由还原成「原规则 + 是谁覆盖的」。 */
function unwrap(decision: PolicyDecision): {
  rule: PolicyRuleId;
  override: PolicyOverride;
  prefixReason: string;
} {
  const reason = decision.reason;

  if (reason.startsWith(APPROVED_PREFIX)) {
    const inner = reason.slice(APPROVED_PREFIX.length);
    return { rule: identifyRule(inner), override: "approval", prefixReason: "" };
  }

  if (decision.standingGrantId) {
    const index = reason.lastIndexOf(STANDING_JOINER);
    if (index >= 0) {
      return {
        rule: identifyRule(reason.slice(index + STANDING_JOINER.length)),
        override: "standing_grant",
        // 这一段本来就是中文（"沿用你此前的批准（已用 1/3 次，…）"），
        // 直接复用，免得同样的授权说明维护两份。
        prefixReason: reason.slice(0, index),
      };
    }
  }

  return { rule: identifyRule(reason), override: null, prefixReason: "" };
}
