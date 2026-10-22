import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Gavel,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { fetchCabinetPage } from "@/lib/api/pages";
import { AUTONOMY_LABELS, roleMeta, statusLabel, statusTone } from "@/lib/agents";
import { money } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  SectionTitle,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Cabinet · Cabinet",
};

export const dynamic = "force-dynamic";

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
              <span className="truncate text-sm font-medium text-ink">{agent.name}</span>
              <Badge tone={statusTone(agent.status)}>{statusLabel(agent.status)}</Badge>
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
              <Sparkles className="size-2.5" /> {agent.lifecycleStage}
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line px-5 py-3">
          <div>
            <div className="mono text-sm text-ink">{Math.round(agent.trustScore)}</div>
            <div className="text-eyebrow uppercase tracking-wider text-faint">trust</div>
          </div>
          <div>
            <div className="mono text-sm text-ink">{rate}%</div>
            <div className="text-eyebrow uppercase tracking-wider text-faint">pass</div>
          </div>
          <div>
            <div className="mono text-sm text-ink">
              {money(budget.settledCents + budget.unknownCents)}
            </div>
            <div className="text-eyebrow uppercase tracking-wider text-faint">本周用量</div>
          </div>
        </div>

        <div className="border-t border-line px-5 py-2.5 text-label text-faint">
          {taskCount} 个任务 · {agent.successCount} 次通过 · {agent.failCount} 次驳回
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 border-t border-line px-5 py-2 text-label text-faint">
          <span className="mono">上限 {money(budget.limitCents)}</span>
          <span>· 已结算 {money(budget.settledCents)}</span>
          {budget.unknownCents > 0 ? <span>· 未知 {money(budget.unknownCents)}</span> : null}
          {budget.reservedCents > 0 ? <span className="text-accent">· 预留 {money(budget.reservedCents)}</span> : null}
          {budget.overrun ? <span className="text-danger">· 已超支</span> : null}
          {budget.legacyUnclassified ? <span className="text-accent">· 含台账前运行</span> : null}
        </div>
      </Card>
    </Link>
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
      className="flex min-w-[150px] items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2 transition-colors hover:border-line2"
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

  const byRole = (role: string) => data.agents.filter((a) => a.role === role);
  const chief = byRole("chief")[0];
  // One pass over tasks instead of one scan per agent card.
  const openTasksByAgent = new Map<string, number>();
  for (const task of data.tasks) {
    if (task.status === "done" || !task.assigneeId) continue;
    openTasksByAgent.set(task.assigneeId, (openTasksByAgent.get(task.assigneeId) ?? 0) + 1);
  }
  const taskCount = (id: string) => openTasksByAgent.get(id) ?? 0;

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <Users className="size-3 text-accent" />
            Cabinet
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">你的个人内阁</h1>
          <p className="mt-1.5 text-xs text-muted">
            {data.agents.length} 个 Agent · {data.agents.filter((a) => a.status === "active").length} 在岗 ·{" "}
            {data.agents.filter((a) => a.lifecycleStage !== "active").length} 成长中
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
          <div className="mx-auto my-3 h-4 w-px bg-line2" />
          <div className="grid gap-2 sm:grid-cols-3">
            {["researcher", "coach", "treasurer"].map((role) => {
              const agent = byRole(role)[0];
              return agent ? <OrgNode key={agent.id} agent={agent} /> : null;
            })}
          </div>
          <div className="mx-auto my-3 h-4 w-px bg-line2" />
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
          <span className="text-line2">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-accent" /> 升级靠信用和审计
          </span>
          <span className="text-line2">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-violet" /> 学徒要考试才能转正
          </span>
        </div>
      </Card>

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
              连续 2 次驳回 → 换人或进入退休评估。所有记录进入哈希链审计日志。
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
