import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Clock3,
  GraduationCap,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { getAgentData } from "@/lib/engine";
import { AUTONOMY_LABELS, roleMeta } from "@/lib/agents";
import { money, pct, relative, timeOnly } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  Progress,
  Stat,
} from "@/components/ui";
import { AgentAdmin, AutonomyControl, ExamButton } from "@/components/actions";

export const dynamic = "force-dynamic";

function statusTone(status: string) {
  if (status === "active") return "teal" as const;
  if (status === "probation") return "accent" as const;
  if (status === "paused") return "neutral" as const;
  return "danger" as const;
}

function successRate(success: number, fail: number) {
  const total = success + fail;
  if (total === 0) return 0;
  return Math.round((success / total) * 100);
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getAgentData(id);
  if (!data) notFound();
  const { agent, runs, memories, skills, tasks } = data;
  const meta = roleMeta(agent.role);
  const rate = successRate(agent.successCount, agent.failCount);

  return (
    <div>
      <Link
        href="/cabinet"
        className="mb-5 inline-flex items-center gap-1 text-[11px] text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回内阁
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Avatar initials={agent.avatar} accent={meta.accent} size={52} />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">{agent.name}</h1>
              <Badge tone={statusTone(agent.status)}>
                {agent.status === "active" ? "在岗" : agent.status === "probation" ? "试用期" : agent.status}
              </Badge>
              {agent.lifecycleStage !== "active" ? (
                <Badge tone="accent">{agent.lifecycleStage}</Badge>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-muted">
              {agent.title} · {meta.objective}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-faint">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3 text-teal" /> {AUTONOMY_LABELS[agent.autonomyLevel]}
              </span>
              <span className="inline-flex items-center gap-1">
                <Brain className="size-3 text-violet" /> 信任 {Math.round(agent.trustScore)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock3 className="size-3" /> 最近活跃 {relative(runs[0]?.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Charter" title="宪章" right={<Badge tone="accent">不可违反</Badge>} />
            <div className="px-5 py-4">
              <p className="text-xs leading-relaxed text-[#c6ccd8]">{agent.charter}</p>
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Performance"
              title="绩效"
              right={<span className="text-[10px] text-faint">{agent.successCount} 通过 / {agent.failCount} 驳回</span>}
            />
            <div className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-4">
              <Stat label="Trust" value={Math.round(agent.trustScore)} hint="0–100" />
              <Stat label="Pass rate" value={`${rate}%`} hint="验收通过率" />
              <Stat label="Spend" value={money(agent.spentCents)} hint={`预算 ${money(agent.budgetCents)}`} />
              <Stat label="Tasks" value={tasks.length} hint="最近任务" />
            </div>
            <div className="space-y-3 border-t border-line px-5 py-4">
              <div>
                <div className="mb-1 flex items-center justify-between text-[10px] text-faint">
                  <span>信任分</span>
                  <span className="mono">{Math.round(agent.trustScore)} / 100</span>
                </div>
                <Progress value={agent.trustScore} tone="teal" />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-[10px] text-faint">
                  <span>预算使用</span>
                  <span className="mono">
                    {agent.budgetCents > 0 ? pct((agent.spentCents / agent.budgetCents) * 100) : "—"}
                  </span>
                </div>
                <Progress
                  value={agent.budgetCents > 0 ? (agent.spentCents / agent.budgetCents) * 100 : 0}
                  tone="accent"
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Runs" title="最近运行" right={<span className="text-[10px] text-faint">可回放</span>} />
            <div className="divide-y divide-line">
              {runs.map((run) => (
                <Link
                  key={run.id}
                  href={`/tasks/${run.taskId}`}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-white/[0.02]"
                >
                  <span
                    className={
                      run.status === "succeeded"
                        ? "size-1.5 rounded-full bg-teal"
                        : run.status === "failed"
                          ? "size-1.5 rounded-full bg-danger"
                          : "size-1.5 rounded-full bg-accent"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[11px] text-ink">{run.id}</div>
                    <div className="mt-0.5 text-[10px] text-faint">
                      {run.taskId} · {run.mode} · {run.tokensIn + run.tokensOut} tokens
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="mono text-[10px] text-muted">{money(run.costCents)}</div>
                    <div className="text-[9px] text-faint">{timeOnly(run.createdAt)}</div>
                  </div>
                </Link>
              ))}
              {runs.length === 0 ? (
                <div className="px-5 py-8 text-center text-xs text-faint">还没有运行记录。</div>
              ) : null}
            </div>
          </Card>

          {skills.length > 0 ? (
            <Card>
              <CardHeader eyebrow="Skills" title="技能与考试" right={<Badge tone="violet">学徒制</Badge>} />
              <div className="divide-y divide-line">
                {skills.map((skill) => (
                  <div key={skill.id} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium text-ink">{skill.name}</div>
                        <div className="mt-0.5 text-[10px] text-faint">
                          v{skill.version} · {skill.status} · {skill.successCount} 通过 / {skill.failCount} 失败
                        </div>
                      </div>
                      <Badge tone={skill.status === "active" ? "teal" : "accent"}>{skill.status}</Badge>
                    </div>
                    <ol className="mt-3 space-y-1 text-[11px] text-muted">
                      {skill.steps.map((step, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="mono text-faint">{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    {skill.eval ? (
                      <div className="mt-3 rounded-md border border-line bg-panel2/50 px-3 py-2 text-[10px] text-muted">
                        考试：{String(skill.eval.passed ?? 0)} / {String(skill.eval.required ?? 5)} ·{" "}
                        {String(skill.eval.status ?? "not_started")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Autonomy" title="授权控制" />
            <div className="px-5 py-4">
              <AutonomyControl agentId={agent.id} level={agent.autonomyLevel} />
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Manage" title="管理动作" />
            <div className="px-5 py-4">
              <AgentAdmin
                agentId={agent.id}
                status={agent.status}
                charter={agent.charter}
                budgetCents={agent.budgetCents}
              />
            </div>
          </Card>

          {agent.role === "apprentice" ? (
            <Card className="border-accent/25 bg-accent/[0.03]">
              <CardHeader eyebrow="Apprenticeship" title="学徒转正" />
              <div className="px-5 py-4">
                <div className="mb-3 flex items-center gap-2 text-[11px] text-muted">
                  <GraduationCap className="size-4 text-accent" />
                  影子学习 → 技能草案 → 5 题留出考试 → 转正
                </div>
                {agent.lifecycleStage === "active" ? (
                  <div className="rounded-md border border-teal/25 bg-teal/[0.04] px-3 py-2 text-[11px] text-teal">
                    已转正：技能 v1 已激活，可接单。
                  </div>
                ) : (
                  <ExamButton />
                )}
                <p className="mt-3 text-[10px] leading-relaxed text-faint">
                  考试由 Auditor 监考；≥4/5 通过。通过后获得技能 v1，信任分 +10。
                </p>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader eyebrow="Tools & grants" title="工具与权限" />
            <div className="space-y-2 px-5 py-4">
              {agent.tools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 text-[11px] text-muted">
                  <KeyRound className="size-3 text-faint" />
                  <span className="mono">{tool}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Memory scope" title="记忆范围" />
            <div className="flex flex-wrap gap-1.5 px-5 py-4">
              {agent.memoryScope.map((scope) => (
                <Badge key={scope} tone="neutral">{scope}</Badge>
              ))}
            </div>
            <div className="border-t border-line px-5 py-3 text-[10px] text-faint">
              只读取授权范围内的记忆；不共享其他 Agent 的私有上下文。
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Memories" title="它记住的事" />
            <div className="divide-y divide-line">
              {memories.slice(0, 5).map((memory) => (
                <div key={memory.id} className="px-5 py-3">
                  <div className="flex items-start gap-2">
                    <BookOpen className="mt-0.5 size-3 text-faint" />
                    <div className="min-w-0">
                      <div className="text-[11px] leading-relaxed text-muted">{memory.content}</div>
                      <div className="mt-1 flex items-center gap-2 text-[9px] text-faint">
                        <span>{memory.type}</span>
                        <span>·</span>
                        <span>{Math.round(memory.confidence * 100)}%</span>
                        <span>·</span>
                        <span>{memory.domain}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {memories.length === 0 ? (
                <div className="px-5 py-6 text-center text-[11px] text-faint">暂无记忆。</div>
              ) : null}
            </div>
          </Card>

          {agent.role === "apprentice" ? (
            <Card className="border-violet/20">
              <div className="flex items-start gap-3 px-5 py-4">
                <Sparkles className="mt-0.5 size-4 text-violet" />
                <div className="text-[11px] leading-relaxed text-muted">
                  学徒的价值不是“多一个 Agent”，而是证明系统能
                  <span className="text-ink">长出</span>新能力：观察 → 提炼 → 考试 → 转正。
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
