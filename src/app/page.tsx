import Link from "next/link";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Gavel,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import { getTodayData } from "@/lib/engine";
import { roleMeta } from "@/lib/agents";
import { dateTime, pct, timeOnly } from "@/lib/format";
import { Badge, Card, CardHeader, Dot, Progress, Stat } from "@/components/ui";
import {
  ApprovalActions,
  BriefButton,
  CheckinForm,
  QuickCreate,
} from "@/components/actions";
import { Markdown } from "@/components/markdown";

export const dynamic = "force-dynamic";

function statusTone(status: string) {
  if (["accepted", "done"].includes(status)) return "teal" as const;
  if (["submitted", "auditing", "awaiting_approval", "suggested"].includes(status))
    return "accent" as const;
  if (["rejected", "failed"].includes(status)) return "danger" as const;
  if (["running"].includes(status)) return "blue" as const;
  return "neutral" as const;
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    planned: "待执行",
    assigned: "已指派",
    awaiting_approval: "待审批",
    approved: "已批准",
    suggested: "建议",
    running: "执行中",
    submitted: "待验收",
    auditing: "验收中",
    accepted: "已通过",
    rejected: "已驳回",
    done: "完成",
    failed: "失败",
  };
  return map[status] ?? status;
}

export default async function TodayPage() {
  const data = await getTodayData();
  const primaryGoal = data.goals[0];
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const today = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());

  const brief =
    data.brief?.narrative ??
    `# 今日早报\n\n目标：${data.goals.map((g) => `${g.title}（${pct(g.progress)}）`).join(" · ")}\n\n## 今天的关键判断\n- 今天有 ${data.tasks.length} 个待推进任务。\n- 有 ${data.approvals.length} 个决定等你。`;

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-faint">
            <Sun className="size-3 text-accent" />
            Today · {today}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            早上好，{data.user.name}
          </h1>
          <p className="mt-1.5 text-xs text-muted">
            第 2 周 · {primaryGoal ? `${primaryGoal.title} ${pct(primaryGoal.progress)}` : "尚未设定目标"} ·{" "}
            {data.tasks.length} 件事在推进
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.16em] text-faint">management</div>
            <div className="mono text-sm text-teal">
              {data.weeklyMetrics.managementMinutes.toFixed(1)} min/day
            </div>
          </div>
          <div className="h-8 w-px bg-line" />
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.16em] text-faint">AAO / week</div>
            <div className="mono text-sm text-accent">
              {data.weeklyMetrics.aao}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.65fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              eyebrow="Morning brief · Atlas"
              title="今天的关键判断"
              right={<BriefButton />}
            />
            <div className="px-5 py-4">
              <Markdown content={brief} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
              <Badge tone="teal">
                <ShieldCheck className="size-2.5" /> 3 条证据已挂载
              </Badge>
              <Badge tone="accent">
                <Sparkles className="size-2.5" /> 1 条洞察待采纳
              </Badge>
              <span className="ml-auto text-[10px] text-faint">
                生成于 {dateTime(data.brief?.createdAt)}
              </span>
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Plan"
              title="今天的事"
              right={
                <Link
                  href="/cabinet"
                  className="flex items-center gap-1 text-[11px] text-muted hover:text-ink"
                >
                  组织 <ArrowRight className="size-3" />
                </Link>
              }
            />
            <div className="divide-y divide-line">
              {data.tasks.slice(0, 3).map((task) => {
                const agent = task.assigneeId ? agentById.get(task.assigneeId) : null;
                return (
                  <Link
                    key={task.id}
                    href={`/tasks/${task.id}`}
                    className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                  >
                    <Dot
                      tone={
                        task.status === "submitted"
                          ? "accent"
                          : task.status === "rejected"
                            ? "danger"
                            : "teal"
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-ink group-hover:text-white">
                        {task.title}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-faint">
                        <span className="text-muted">{agent?.name ?? "未指派"}</span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="size-2.5" /> {task.estimateMin} min
                        </span>
                        <span>·</span>
                        <span>{timeOnly(task.dueAt)}</span>
                      </div>
                    </div>
                    <Badge tone={statusTone(task.status)}>{statusLabel(task.status)}</Badge>
                  </Link>
                );
              })}
              {data.tasks.length > 3 ? (
                <Link
                  href="/cabinet"
                  className="flex items-center justify-between px-5 py-2.5 text-[10px] text-faint transition-colors hover:text-muted"
                >
                  <span>还有 {data.tasks.length - 3} 件在队列里</span>
                  <span>看组织 →</span>
                </Link>
              ) : null}
              {data.tasks.length === 0 ? (
                <div className="px-5 py-8 text-center text-xs text-faint">
                  今天没有待推进任务。
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Decisions"
              title="需要你决定"
              right={
                <Badge tone={data.approvals.length + (data.council ? 1 : 0) > 0 ? "accent" : "neutral"}>
                  {data.approvals.length + (data.council ? 1 : 0)} 待处理
                </Badge>
              }
            />
            <div className="divide-y divide-line">
              {data.approvals.map((approval) => (
                <div key={approval.id} className="px-5 py-4">
                  <div className="flex items-start gap-2">
                    <CircleAlert className="mt-0.5 size-3.5 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-ink">
                        外部动作：{String(approval.payload.provider ?? "")}{" "}
                        {String(approval.payload.time ?? "")}
                      </div>
                      <div className="mt-1 text-[11px] text-muted">
                        {String(approval.payload.note ?? "")} · 预计 ¥
                        {Number(approval.payload.costCents ?? 0) / 100}
                      </div>
                    </div>
                    <ApprovalActions approvalId={approval.id} />
                  </div>
                </div>
              ))}

              {data.council ? (
                <Link
                  href="/council"
                  className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-white/[0.02]"
                >
                  <Gavel className="size-3.5 text-violet" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-ink">
                      内阁会议：{data.council.topic}
                    </div>
                    <div className="mt-1 text-[10px] text-faint">
                      触发：{data.council.trigger} · 5 位 Agent 已提交立场
                    </div>
                  </div>
                  <ArrowRight className="size-3.5 text-faint" />
                </Link>
              ) : null}

              {data.approvals.length === 0 && !data.council ? (
                <div className="px-5 py-8 text-center text-xs text-faint">
                  没有待决定事项。
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Yesterday" title="昨天的偏差" />
            <div className="px-5 py-4">
              {data.yesterdayCheckin ? (
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span className="mono text-ink">{data.yesterdayCheckin.energy}/5</span> 精力
                    <span className="text-line2">·</span>
                    <span className="mono text-ink">{data.yesterdayCheckin.mood}/5</span> 心情
                  </div>
                  <div className="text-[11px] text-muted">
                    {data.yesterdayCheckin.completed.filter((c) => !c.done).length} 项未完成
                  </div>
                  <div className="basis-full text-[11px] text-muted">
                    “{data.yesterdayCheckin.note}”
                  </div>
                  <Badge tone="teal">
                    <CheckCircle2 className="size-2.5" /> 已写入记忆
                  </Badge>
                </div>
              ) : (
                <div className="text-xs text-faint">还没有昨天的 check-in。</div>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Check-in" title="今天感觉如何？" />
            <div className="px-5 py-4">
              {data.checkin ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-teal">
                    <CheckCircle2 className="size-3.5" /> 今天已 check-in
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Energy" value={`${data.checkin.energy}/5`} />
                    <Stat label="Mood" value={`${data.checkin.mood}/5`} />
                  </div>
                  <div className="rounded-md border border-line bg-panel2/50 px-3 py-2 text-[11px] text-muted">
                    {data.checkin.note || "无备注"}
                  </div>
                </div>
              ) : (
                <CheckinForm
                  tasks={data.tasks.map((t) => ({ id: t.id, title: t.title }))}
                />
              )}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Cabinet pulse" title="Agent 动态" />
            <div className="divide-y divide-line">
              {data.agents.slice(0, 6).map((agent) => {
                const meta = roleMeta(agent.role);
                return (
                  <Link
                    key={agent.id}
                    href={`/cabinet/${agent.id}`}
                    className="flex items-center gap-2.5 px-5 py-2.5 transition-colors hover:bg-white/[0.02]"
                  >
                    <span
                      className="flex size-6 items-center justify-center rounded-md border font-mono text-[9px]"
                      style={{
                        color: meta.accent,
                        borderColor: `${meta.accent}55`,
                        background: `${meta.accent}14`,
                      }}
                    >
                      {agent.avatar}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-ink">{agent.name}</div>
                      <div className="text-[9px] text-faint">{meta.objective}</div>
                    </div>
                    <div className="text-right">
                      <div className="mono text-[10px] text-muted">L{agent.autonomyLevel}</div>
                      <div className="text-[9px] text-faint">{Math.round(agent.trustScore)}</div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Goals" title="目标进度" />
            <div className="space-y-4 px-5 py-4">
              {data.goals.map((goal) => (
                <div key={goal.id}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-ink">{goal.title}</span>
                    <span className="mono text-[10px] text-muted">{pct(goal.progress)}</span>
                  </div>
                  <Progress value={goal.progress} tone={goal.domain === "health" ? "teal" : "accent"} />
                  <div className="mt-1 text-[9px] text-faint">{goal.target}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Create" title="快速创建" />
            <div className="px-5 py-4">
              <QuickCreate
                agents={data.agents.map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                  role: agent.role,
                }))}
                goals={data.goals.map((goal) => ({
                  id: goal.id,
                  title: goal.title,
                }))}
              />
            </div>
          </Card>

          <Card className="border-accent/20 bg-accent/[0.03]">
            <div className="flex items-start gap-3 px-5 py-4">
              <Brain className="mt-0.5 size-4 text-accent" />
              <div>
                <div className="text-xs font-medium text-ink">每天 3 分钟</div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  早报 1 分钟、check-in 30 秒、审批 1 分钟。其余交给内阁。
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
