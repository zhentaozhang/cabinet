/**
 * 异议的证伪条件怎么读给用户听。
 *
 * `FalsificationCondition` 里的 `metric` 是内部键，`threshold` 带着那个键的单位：
 * `budget_spend_cents` 的阈值是「分」（种子里 48000），其余是次数。复盘页原来把三个字段
 * 原样印出来——`budget_spend_cents >= 48000 · 7 天`——用户读到的既不是中文，也不是钱：
 * ¥480 的阈值被印成了四万八；`src/server/services/commands/council/dissent.ts` 写进记忆
 * 的判例与证据引文是同一个形状（`budget_spend_cents = 52000`），两处一起把一个读不懂的
 * 数说成了结论。
 *
 * 所以单位与措辞只在这里定义一次：页面读条件、命令层读实测值，走同一套词。
 * 内部键本身仍然保留在审计行与判例的 `value` 里（机器要能按原样比对），只是不再拿给用户看。
 */

export type DissentConditionLike = {
  metric: string;
  operator: string;
  threshold: number;
  windowDays: number;
};

type MetricCopy = { label: string; unit: "cents" | "次" | "个" | null };

const METRIC_COPY: Record<string, MetricCopy> = {
  budget_spend_cents: { label: "支出", unit: "cents" },
  audit_reject_count: { label: "驳回", unit: "次" },
  task_failure_count: { label: "失败任务", unit: "个" },
  agent_paused: { label: "暂停", unit: "次" },
};

/** 未知键退回原样：说得出「观测的是什么」总比印一个替代词好。 */
function metricCopy(metric: string): MetricCopy {
  return METRIC_COPY[metric] ?? { label: metric, unit: null };
}

const OPERATOR_COPY: Record<string, string> = {
  ">=": "≥",
  ">": ">",
  "==": "=",
};

/** 实测值：分换算成元，其余按次数带上量词。 */
export function dissentValueText(metric: string, value: number): string {
  const { unit } = metricCopy(metric);
  if (unit === "cents") return `¥${(value / 100).toFixed(2)}`;
  if (unit === null) return String(value);
  return `${value} ${unit}`;
}

/** 整句条件，例如「7 天内支出 ≥ ¥480.00」「7 天内驳回 ≥ 2 次」。 */
export function dissentConditionText(condition: DissentConditionLike): string {
  const operator = OPERATOR_COPY[condition.operator] ?? condition.operator;
  const window =
    condition.windowDays > 0 ? `${condition.windowDays} 天内` : "观察期内";
  const label = metricCopy(condition.metric).label;
  // 中文词直接接在前面；退回原样的英文键要留一个空格，否则读成「天内custom_metric」。
  const spacer = /^[A-Za-z_]/.test(label) ? " " : "";
  return `${window}${spacer}${label} ${operator} ${dissentValueText(condition.metric, condition.threshold)}`;
}
