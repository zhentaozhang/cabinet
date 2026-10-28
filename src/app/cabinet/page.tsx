import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  CircleSlash,
  Gavel,
  Lightbulb,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { fetchCabinetPage } from "@/lib/api/pages";
import {
  capabilitySummary,
  isImplemented,
  toolPlanRegistry,
} from "@/lib/domain/tool-plan";
import { AUTONOMY_LABELS, roleMeta, statusLabel } from "@/lib/agents";
import { money } from "@/lib/format";
import {
  agentHeadcount,
  escalationPolicyLine,
  tasksPerAgent,
} from "@/lib/presentation/cabinet-view";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  SectionTitle,
  StatusBadge,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Cabinet · Cabinet",
};

export const dynamic = "force-dynamic";

/**
 * One tile of the knowledge strip. Kept dumb: the cabinet page is the only
 * consumer, and the values are already aggregated server-side.
 */
function KnowledgeCell({
  icon,
  label,
  value,
  unit,
  detail,
  href,
  alert = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  unit: string;
  detail: string;
  href: string;
  alert?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group bg-panel px-4 py-3.5 transition-colors hover:bg-panel2/70"
    >
      <div className="flex items-center gap-1.5 text-eyebrow tracking-[0.14em] text-faint uppercase">
        {icon}
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="mono text-page text-ink">{value}</span>
        <span className="text-label text-muted">{unit}</span>
      </div>
      <div
        className={
          alert
            ? "mt-1 text-label text-danger"
            : "mt-1 text-label text-faint"
        }
      >
        {detail}
      </div>
    </Link>
  );
}

/**
 * 「声明了」曾被画成「能用」：注册表里有 18 个工具，可执行链只有 web_search /
 * web_fetch 两个分支，其余 16 个跑到就记 not_connected。页面不写清这一层，
 * 用户会以为自己授权的能力真的在跑。
 *
 * 分组只问注册表（isImplemented），不在这里另建一份"已接入"清单——两份清单
 * 迟早分叉，然后页面写"已接入"、运行日志写 not_connected，两个都自称有据。
 */
function capabilityBucket(tool: string): "implemented" | "declared" | "mcp" | "unknown" {
  if (isImplemented(tool)) return "implemented";
  // MCP 工具由运行期发现，静态注册表没有资格替它回答"能不能执行"。
  if (tool.startsWith("mcp:")) return "mcp";
  // 名字不在注册表里就是拼错了/拼漏了，不能混进"声明未接入"——那会让一个
  // 从未存在过的工具看起来像"以后会接上"。
  if (!(tool in toolPlanRegistry())) return "unknown";
  return "declared";
}

/** 能力矩阵的一行：一个 Agent 声明了什么，这个运行时能执行什么。 */
function CapabilityRow({
  agent,
  budget,
}: {
  agent: {
    id: string;
    name: string;
    title: string;
    role: string;
    avatar: string;
    autonomyLevel: number;
    tools: string[];
    memoryScope: string[];
  };
  budget: {
    limitCents: number;
    settledCents: number;
    unknownCents: number;
  };
}) {
  const meta = roleMeta(agent.role);
  const buckets = { implemented: [] as string[], declared: [] as string[], mcp: [] as string[], unknown: [] as string[] };
  for (const tool of agent.tools) buckets[capabilityBucket(tool)].push(tool);
  const usedCents = budget.settledCents + budget.unknownCents;

  return (
    <div className="bg-panel px-5 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar initials={agent.avatar} accent={meta.accent} size={24} />
          <Link
            href={`/cabinet/${agent.id}`}
            className="truncate text-label text-ink hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
          >
            {agent.name}
          </Link>
          <span className="truncate text-label text-faint">{meta.objective}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-label text-faint">
          <span className="text-accent">{AUTONOMY_LABELS[agent.autonomyLevel]}</span>
          <span aria-hidden="true">·</span>
          <span className="mono">
            本周 {money(usedCents)}
            {budget.limitCents > 0 ? ` / ${money(budget.limitCents)}` : " · 无预算"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="truncate">
            记忆 {agent.memoryScope.length > 0 ? agent.memoryScope.join("/") : "未设范围"}
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {buckets.implemented.map((tool) => (
          <Badge key={tool} tone="teal">
            <CheckCircle2 className="size-2.5" aria-hidden="true" /> {tool}
          </Badge>
        ))}
        {buckets.declared.map((tool) => (
          // 弱化是刻意的：虚线 + faint，读起来是"这个名字在这里，但它跑不了"。
          <span
            key={tool}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-line2 px-2 py-0.5 text-label text-faint"
          >
            <CircleSlash className="size-2.5" aria-hidden="true" /> {tool}
          </span>
        ))}
        {buckets.mcp.map((tool) => (
          <span
            key={tool}
            className="inline-flex items-center gap-1 rounded-md border border-line2 px-2 py-0.5 text-label text-muted"
          >
            {tool} · 运行期解析
          </span>
        ))}
        {buckets.unknown.map((tool) => (
          <span
            key={tool}
            className="inline-flex items-center gap-1 rounded-md border border-danger/40 px-2 py-0.5 text-label text-danger"
          >
            {tool} · 未登记
          </span>
        ))}
        {buckets.implemented.length === 0 ? (
          <span className="text-label text-faint">
            这个 Agent 声明的工具一个都没接入，目前只能靠模型自身能力干活。
          </span>
        ) : null}
      </div>
    </div>
  );
}

function successRate(success: number, fail: number) {
  const total = success + fail;
  if (total === 0) return 0;
  return Math.round((success / total) * 100);
}

function AgentCard({
  agent,
  taskCount,
  budget,
}: {
  budget: {
    limitCents: number;
    settledCents: number;
    unknownCents: number;
    reservedCents: number;
    overrun: boolean;
    legacyUnclassified: boolean;
  };
  agent: {
    id: string;
    name: string;
    title: string;
    role: string;
    avatar: string;
    objective: string;
    status: string;
    autonomyLevel: number;
    trustScore: number;
    successCount: number;
    failCount: number;
    lifecycleStage: string;
  };
  taskCount: number;
}) {
  const meta = roleMeta(agent.role);
  const rate = successRate(agent.successCount, agent.failCount);
  return (
    <Link href={`/cabinet/${agent.id}`} className="group block">
      <Card className="h-full transition-colors group-hover:border-line2 group-hover:bg-panel2/60">
        <div className="flex items-start gap-3 px-5 pt-5">
          <Avatar initials={agent.avatar} accent={meta.accent} size={38} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-emphasis font-medium text-ink">{agent.name}</span>
              <StatusBadge status={agent.status} />
            </div>
            <div className="mt-0.5 text-label text-faint">
              {agent.title} · {meta.objective}
            </div>
          </div>
          <ArrowRight className="size-3.5 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted" />
        </div>

        <div className="px-5 pt-4">
          <div className="flex items-center justify-between text-label">
            <span className="text-faint">Autonomy</span>
            <span className="text-accent">{AUTONOMY_LABELS[agent.autonomyLevel]}</span>
          </div>
          <div className="mt-1.5 flex gap-1">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={
                  n <= agent.autonomyLevel
                    ? "h-1 flex-1 rounded-full bg-accent/80"
                    : "h-1 flex-1 rounded-full bg-line"
                }
              />
            ))}
          </div>
          {agent.lifecycleStage !== "active" ? (
            <div className="mt-2 inline-flex items-center gap-1 text-label text-accent">
              <Sparkles className="size-2.5" /> {statusLabel(agent.lifecycleStage)}
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line px-5 py-3">
          <div>
            <div className="mono text-emphasis text-ink">{Math.round(agent.trustScore)}</div>
            <div className="text-eyebrow uppercase tracking-wider text-faint">trust</div>
          </div>
          <div>
            <div className="mono text-emphasis text-ink">{rate}%</div>
            <div className="text-eyebrow uppercase tracking-wider text-faint">pass</div>
          </div>
          <div>
            <div className="mono text-emphasis text-ink">
              {money(budget.settledCents + budget.unknownCents)}
            </div>
            <div className="text-eyebrow uppercase tracking-wider text-faint">本周用量</div>
          </div>
        </div>

        {/* One footer, not three stacked rules: three hairlines in a row read as
            a table edge and chop the card into stripes. The activity line sits
            above the budget line and a single rule separates them from the
            metrics grid. */}
        <div className="space-y-1 border-t border-line px-5 py-3 text-label text-faint">
          <div>
            共 {taskCount} 个任务 · {agent.successCount} 次通过 · {agent.failCount} 次驳回
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5">
            <span className="mono">上限 {money(budget.limitCents)}</span>
            <span>· 已结算 {money(budget.settledCents)}</span>
            {budget.unknownCents > 0 ? <span>· 未知 {money(budget.unknownCents)}</span> : null}
            {budget.reservedCents > 0 ? <span className="text-accent">· 预留 {money(budget.reservedCents)}</span> : null}
            {budget.overrun ? <span className="text-danger">· 已超支</span> : null}
            {budget.legacyUnclassified ? <span className="text-accent">· 含台账前运行</span> : null}
          </div>
        </div>
      </Card>
    </Link>
  );
}

/**
 * The org-chart branch: stem → bar → one drop per column.
 *
 * Rendered as three separate pieces rather than one tall line because the bar
 * has to stop at the outer column centres (16.7% / 83.3% of a 3-column grid);
 * a full-width bar would visibly overhang past the first and last nodes.
 */
function BranchConnector() {
  return (
    <div aria-hidden="true">
      {/* Wide layout: stem, bar, three drops. */}
      <div className="hidden sm:block">
        <div className="mx-auto h-4 w-px bg-line2" />
        <div className="mx-auto h-px w-2/3 bg-line2" />
        <div className="grid grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex justify-center">
              <div className="h-3 w-px bg-line2" />
            </div>
          ))}
        </div>
      </div>
      {/* Narrow layout: a single column has nothing to branch to. */}
      <div className="mx-auto my-3 h-4 w-px bg-line2 sm:hidden" />
    </div>
  );
}

function OrgNode({
  agent,
  accent,
  label,
}: {
  agent: {
    id: string;
    name: string;
    title: string;
    avatar: string;
    role: string;
    autonomyLevel: number;
  };
  accent?: string;
  label?: string;
}) {
  const meta = roleMeta(agent.role);
  const color = accent ?? meta.accent;
  return (
    <Link
      href={`/cabinet/${agent.id}`}
      className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2 transition-colors hover:border-line2"
    >
      <span
        className="flex size-7 items-center justify-center rounded-md border font-mono text-label"
        style={{ color, borderColor: `${color}55`, background: `${color}14` }}
      >
        {agent.avatar}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-label text-ink">{agent.name}</span>
        <span className="block truncate text-label text-faint">
          {label ?? agent.title} · L{agent.autonomyLevel}
        </span>
      </span>
    </Link>
  );
}

export default async function CabinetPage() {
  const data = await fetchCabinetPage();

  if (data.agents.length === 0) {
    return (
      <div className="mx-auto max-w-xl py-12">
        <EmptyState
          icon={<Users className="size-4" />}
          title="这个内阁还没有成员"
          hint="七个 Agent 的位置已经留好：Chief 拆解、Auditor 验收、Critic 唱反调。创建工作区后它们会按宪章上岗。"
        />
        <div className="mt-4 flex justify-center">
          <Link
            href="/setup"
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-label text-accent transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
          >
            去创建工作区 <ArrowRight className="size-3" />
          </Link>
        </div>
      </div>
    );
  }

  const knowledge = data.knowledge;
  // 注册表是能力矩阵的唯一事实来源，见 capabilityBucket 的注释。
  const capabilities = capabilitySummary();
  const byRole = (role: string) => data.agents.filter((a) => a.role === role);
  const chief = byRole("chief")[0];
  // One pass over tasks instead of one scan per agent card.
  const tasksByAgent = tasksPerAgent(data.tasks);
  const taskCount = (id: string) => tasksByAgent.get(id) ?? 0;
  const headcount = agentHeadcount(data.agents);

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <Users className="size-3 text-accent" />
            Cabinet
          </div>
          <h1 className="text-page font-semibold tracking-tight text-ink">你的个人内阁</h1>
          <p className="mt-1.5 text-label text-muted">
            {headcount.total} 个 Agent · {headcount.onDuty} 在岗 · {headcount.growing} 成长中
            {headcount.retired > 0 ? ` · ${headcount.retired} 已退休` : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="teal">
            <ShieldCheck className="size-2.5" /> 分权验收已启用
          </Badge>
          <Link
            href="/council"
            className="inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-label text-ink hover:border-line2/80"
          >
            <Gavel className="size-3 text-violet" /> 内阁会议
          </Link>
        </div>
      </div>

      <Card className="mb-6 overflow-hidden">
        <CardHeader
          eyebrow="Org chart"
          title="组织与制衡"
          right={<span className="text-label text-faint">执行 · 监督 · 成长</span>}
        />
        <div className="px-5 py-5">
          {chief ? (
            <div className="flex justify-center">
              <OrgNode agent={chief} />
            </div>
          ) : null}

          {/* A single 1px stem said nothing about who reports to whom. The
              branch below is a stem, a bar spanning the three column centres,
              and one drop per column, so the line lands on each node. */}
          <BranchConnector />

          <div className="grid gap-2 sm:grid-cols-3">
            {["researcher", "coach", "treasurer"].map((role) => {
              const agent = byRole(role)[0];
              return agent ? <OrgNode key={agent.id} agent={agent} /> : null;
            })}
          </div>

          {/* The second band is not a child of the first: Auditor and Critic
              answer to the Chief, not to the Researcher. Drawing a plain
              vertical line here would assert a chain of command that does not
              exist, so the band gets its own label and a dashed link. */}
          <div className="mt-4 mb-3 flex items-center gap-3">
            <span className="h-px flex-1 border-t border-dashed border-line2" />
            <span className="text-eyebrow tracking-[0.14em] text-faint uppercase">
              监督与成长 · 同样向 Chief 汇报
            </span>
            <span className="h-px flex-1 border-t border-dashed border-line2" />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {["auditor", "apprentice", "critic"].map((role) => {
              const agent = byRole(role)[0];
              return agent ? (
                <OrgNode
                  key={agent.id}
                  agent={agent}
                  label={agent.role === "auditor" ? "独立监督" : undefined}
                />
              ) : null;
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3 text-label text-faint">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-teal" /> 执行者不能验收自己的产物
          </span>
          <span aria-hidden="true" className="text-faint">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-accent" /> 升级靠信用和审计
          </span>
          <span aria-hidden="true" className="text-faint">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-violet" /> 学徒要考试才能转正
          </span>
        </div>
      </Card>

      <div className="mb-6">
        <Card>
          <CardHeader
            eyebrow="Knowledge"
            title="知识资产"
            right={
              <Link
                href="/memory"
                className="inline-flex items-center gap-1 text-label text-faint hover:text-muted"
              >
                查看记忆 <ArrowRight className="size-3" />
              </Link>
            }
          />
          <div className="grid gap-px bg-line/60 sm:grid-cols-2 xl:grid-cols-4">
            <KnowledgeCell
              icon={<Sparkles className="size-3.5 text-teal" />}
              label="技能"
              value={knowledge.skills.certified}
              unit="项已转正"
              detail={`共 ${knowledge.skills.total} 项，含草案`}
              href="/cabinet"
            />
            <KnowledgeCell
              icon={<Brain className="size-3.5 text-blue" />}
              label="记忆"
              value={knowledge.memories.active}
              unit="条有效"
              detail={
                knowledge.memories.conflicted > 0
                  ? `${knowledge.memories.conflicted} 条自相矛盾，待你裁定`
                  : "没有互相冲突的事实"
              }
              href="/memory"
              alert={knowledge.memories.conflicted > 0}
            />
            <KnowledgeCell
              icon={<Lightbulb className="size-3.5 text-accent" />}
              label="洞察"
              value={knowledge.insights.applied}
              unit="条已采纳"
              detail={`${knowledge.insights.proposed} 条待采纳`}
              href="/review"
            />
            <KnowledgeCell
              icon={<Gavel className="size-3.5 text-violet" />}
              label="判例"
              value={knowledge.dissents.vindicated}
              unit="条已平反"
              detail={
                knowledge.dissents.pending > 0
                  ? `${knowledge.dissents.pending} 条仍在观察`
                  : `共 ${knowledge.dissents.total} 条异议`
              }
              href="/review"
            />
          </div>
        </Card>
      </div>

      <div className="mb-6">
        <Card>
          <CardHeader
            eyebrow="Capabilities"
            title="能力矩阵：声明 vs 能执行"
            right={
              <span className="text-label text-faint">
                注册表 {capabilities.implemented.length + capabilities.declaredOnly.length} 个工具 ·{" "}
                <span className="text-teal">{capabilities.implemented.length} 个真能执行</span>
              </span>
            }
          />
          <div className="border-b border-line px-5 py-3 text-label leading-relaxed text-muted">
            工具名不是能力。下面每个 Agent 的工具分成两堆：实线的有执行器，调用会真的发出去；
            虚线的只是声明，一步也执行不了，运行日志里记 <span className="mono">not_connected</span>。
          </div>
          <div className="grid gap-px bg-line/60">
            {data.agents.map((agent) => (
              <CapabilityRow
                key={agent.id}
                agent={agent}
                budget={data.budgets[agent.id]}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3 text-label text-faint">
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-teal" /> 已接入：真有执行器，会发出外部调用
            </span>
            <span aria-hidden="true" className="text-faint">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-line2" /> 声明未接入：注册表里有名字，执行链里没有分支
            </span>
            <span aria-hidden="true" className="text-faint">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-danger" /> 未登记：名字打错了，连声明都不算
            </span>
          </div>
        </Card>
      </div>

      <SectionTitle
        eyebrow="Agents"
        title="绩效与授权"
        hint="点开任一 Agent，看宪章、工具、记忆范围和运行历史。"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            taskCount={taskCount(agent.id)}
            budget={data.budgets[agent.id]}
          />
        ))}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader eyebrow="Separation of duties" title="制度" />
          <div className="space-y-3 px-5 py-4 text-label leading-relaxed text-muted">
            <p>
              <span className="text-ink">执行者</span>提交产物与自评；
              <span className="text-ink">Auditor</span>按验收标准独立检查。
            </p>
            <p>
              Chief 不能推翻 Auditor；只有你能覆盖，且必须留下理由。
            </p>
            <p>
              {escalationPolicyLine(data.policy.rejectStreakLimit)}
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader eyebrow="Settings" title="数据与账号" />
          <div className="px-5 py-4">
            <p className="text-label leading-relaxed text-muted">
              导出备份、彻底删除账号，以及查看工作区规模，都收在设置里。
            </p>
            <Link
              href="/setup"
              className="mt-3 inline-flex items-center gap-1 text-label text-accent transition-colors hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
            >
              打开设置 <ArrowRight className="size-3" />
            </Link>
          </div>
        </Card>
        <Card>
          <CardHeader eyebrow="Autonomy ladder" title="授权阶梯" />
          <div className="space-y-2 px-5 py-4 text-label">
            {[
              ["L1", "建议", "每个动作都要你确认"],
              ["L2", "审批后执行", "内部自动，外部动作需批准"],
              ["L3", "审计后自主", "宪章内自主，事后报告"],
            ].map(([level, name, desc]) => (
              <div key={level} className="flex items-center gap-3">
                <span className="mono w-6 text-accent">{level}</span>
                <span className="w-20 text-ink">{name}</span>
                <span className="text-faint">{desc}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
