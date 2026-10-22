import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileText,
  Play,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { fetchTaskPage } from "@/lib/api/pages";
import { roleMeta, statusLabel, statusTone } from "@/lib/agents";
import { dateTime, money, timeOnly } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
} from "@/components/ui";
import { TaskActions } from "@/components/actions";
import { Markdown } from "@/components/markdown";

export const metadata: Metadata = {
  title: "Task · Cabinet",
};

export const dynamic = "force-dynamic";

const STEP_TONE: Record<string, string> = {
  context: "text-blue",
  plan: "text-accent",
  tool: "text-violet",
  draft: "text-teal",
  submit: "text-muted",
  audit: "text-danger",
};

export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchTaskPage(id);
  if (!data) notFound();
  const { task, goal, assignee, auditor, runs, steps, artifacts, approvals, audit } = data;

  const stepsByRun = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsByRun.get(step.runId) ?? [];
    list.push(step);
    stepsByRun.set(step.runId, list);
  }

  const latestAudit = audit.find((a) => a.action.startsWith("audit."));

  return (
    <div>
      <Link
        href="/"
        className="mb-5 inline-flex items-center gap-1 text-[11px] text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回今日
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(task.status)}>{statusLabel(task.status)}</Badge>
            {goal ? <Badge tone="neutral">{goal.title}</Badge> : null}
            <span className="mono text-[10px] text-faint">{task.id}</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{task.title}</h1>
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted">{task.description}</p>
        </div>
        <TaskActions taskId={task.id} status={task.status} />
      </div>

      {latestAudit ? (
        <div
          className={
            latestAudit.action === "audit.accept"
              ? "mb-5 flex items-start gap-3 rounded-xl border border-teal/25 bg-teal/[0.04] px-4 py-3"
              : "mb-5 flex items-start gap-3 rounded-xl border border-danger/25 bg-danger/[0.04] px-4 py-3"
          }
        >
          {latestAudit.action === "audit.accept" ? (
            <CheckCircle2 className="mt-0.5 size-4 text-teal" />
          ) : (
            <XCircle className="mt-0.5 size-4 text-danger" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-ink">
              {latestAudit.action === "audit.accept" ? "Auditor 验收通过" : "Auditor 驳回"}
            </div>
            <div className="mt-1 text-[11px] text-muted">
              {String((latestAudit.after as Record<string, unknown> | null)?.reason ?? "")}
            </div>
          </div>
          <span className="text-[10px] text-faint">{dateTime(latestAudit.createdAt)}</span>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Acceptance criteria" title="验收标准" />
            <div className="px-5 py-4">
              <p className="text-xs leading-relaxed text-[#c6ccd8]">{task.acceptanceCriteria}</p>
              {task.acceptanceChecklist?.length ? (
                <div className="mt-3 space-y-1.5 rounded-md border border-line bg-panel2/40 px-3 py-2">
                  {task.acceptanceChecklist.map((item, index) => {
                    const result = task.acceptanceReport?.[index];
                    const label =
                      item.type === "contains"
                        ? `包含「${item.value}」`
                        : item.type === "min_words"
                          ? `至少 ${item.value} 字`
                          : item.type === "min_sources"
                            ? `至少 ${item.value} 个来源`
                            : item.type === "section"
                              ? `包含章节「${item.value}」`
                              : `人工项：${item.note}`;
                    return (
                      <div
                        key={`${item.type}-${index}`}
                        className="flex items-start gap-1.5 text-[10px]"
                      >
                        {result ? (
                          result.passed ? (
                            <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-teal" />
                          ) : (
                            <XCircle className="mt-0.5 size-3 shrink-0 text-danger" />
                          )
                        ) : (
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-faint" />
                        )}
                        <span className="text-muted">{label}</span>
                        {result ? (
                          <span className="text-faint">· {result.reason}</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-faint">
                <span>预估 {task.estimateMin} 分钟</span>
                <span>截止 {dateTime(task.dueAt)}</span>
                <span>创建者 {task.createdBy}</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Run trace"
              title="运行轨迹"
              right={<span className="text-[10px] text-faint">{runs.length} 次运行</span>}
            />
            {runs.length === 0 ? (
              <div className="px-5 py-6">
                <EmptyState
                  title="还没有运行"
                  hint="点击右上角「执行」，让 Agent 产出第一版。"
                />
              </div>
            ) : (
              <div className="divide-y divide-line">
                {[...runs].reverse().map((run) => {
                  const runSteps = stepsByRun.get(run.id) ?? [];
                  return (
                    <div key={run.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            run.status === "succeeded"
                              ? "size-1.5 rounded-full bg-teal"
                              : run.status === "failed"
                                ? "size-1.5 rounded-full bg-danger"
                                : "size-1.5 rounded-full bg-accent"
                          }
                        />
                        <span className="mono text-[11px] text-ink">{run.id}</span>
                        <Badge tone={run.agentId === "ag_auditor" ? "danger" : "neutral"}>
                          {run.agentId}
                        </Badge>
                        <span className="text-[10px] text-faint">
                          {run.status} · {run.mode} · {run.tokensIn + run.tokensOut} tokens ·{" "}
                          {money(run.costCents)}
                        </span>
                        <span className="ml-auto text-[10px] text-faint">
                          {timeOnly(run.startedAt)} → {timeOnly(run.endedAt)}
                        </span>
                      </div>

                      <div className="mt-3 space-y-0">
                        {runSteps.map((step, index) => (
                          <div key={step.id} className="relative flex gap-3 pb-3">
                            {index < runSteps.length - 1 ? (
                              <span className="absolute left-[7px] top-3 h-full w-px bg-line" />
                            ) : null}
                            <span
                              className={
                                "relative z-10 mt-1 size-[15px] shrink-0 rounded-full border border-line bg-panel text-center text-[8px] leading-[13px] " +
                                (STEP_TONE[step.type] ?? "text-muted")
                              }
                            >
                              {step.idx}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={"text-[11px] font-medium " + (STEP_TONE[step.type] ?? "text-muted")}>
                                  {step.type}
                                </span>
                                {step.tool ? (
                                  <span className="mono rounded border border-line bg-panel2 px-1.5 py-0.5 text-[9px] text-violet">
                                    {step.tool}
                                  </span>
                                ) : null}
                                <span className="text-[9px] text-faint">
                                  {step.latencyMs}ms · {step.tokensIn + step.tokensOut} tok
                                </span>
                              </div>
                              <details className="group mt-1">
                                <summary className="cursor-pointer text-[10px] text-faint hover:text-muted">
                                  查看输入 / 输出
                                </summary>
                                <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                                  <pre className="overflow-x-auto rounded border border-line bg-[#0b0e14] p-2 text-[9px] leading-relaxed text-muted">
                                    {JSON.stringify(step.input, null, 2)}
                                  </pre>
                                  <pre className="overflow-x-auto rounded border border-line bg-[#0b0e14] p-2 text-[9px] leading-relaxed text-teal/80">
                                    {JSON.stringify(step.output, null, 2)}
                                  </pre>
                                </div>
                              </details>
                            </div>
                          </div>
                        ))}
                      </div>

                      {run.replayKey ? (
                        <div className="mt-2 flex items-center gap-1 text-[9px] text-faint">
                          <Play className="size-2.5" /> replay: <span className="mono">{run.replayKey}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader eyebrow="Artifacts" title="产物" />
            {artifacts.length === 0 ? (
              <div className="px-5 py-6 text-center text-xs text-faint">暂无产物。</div>
            ) : (
              <div className="divide-y divide-line">
                {artifacts.slice(0, 3).map((artifact) => (
                  <div key={artifact.id} className="px-5 py-4">
                    <div className="mb-2 flex items-center gap-2">
                      <FileText className="size-3.5 text-teal" />
                      <span className="text-xs font-medium text-ink">{artifact.title}</span>
                      <span className="text-[9px] text-faint">{dateTime(artifact.createdAt)}</span>
                    </div>
                    <details open={artifact.id === artifacts[0]?.id}>
                      <summary className="cursor-pointer text-[10px] text-faint hover:text-muted">
                        展开内容
                      </summary>
                      <div className="mt-2 rounded-lg border border-line bg-[#0b0e14] px-4 py-3">
                        <Markdown content={artifact.content} />
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader eyebrow="Ownership" title="谁负责" />
            <div className="space-y-3 px-5 py-4">
              {assignee ? (
                <Link href={`/cabinet/${assignee.id}`} className="flex items-center gap-2.5">
                  <Avatar initials={assignee.avatar} accent={roleMeta(assignee.role).accent} size={30} />
                  <div>
                    <div className="text-[11px] text-ink">{assignee.name}</div>
                    <div className="text-[9px] text-faint">执行 · {assignee.title}</div>
                  </div>
                </Link>
              ) : null}
              {auditor ? (
                <Link href={`/cabinet/${auditor.id}`} className="flex items-center gap-2.5">
                  <Avatar initials={auditor.avatar} accent={roleMeta(auditor.role).accent} size={30} />
                  <div>
                    <div className="text-[11px] text-ink">{auditor.name}</div>
                    <div className="text-[9px] text-faint">验收 · {auditor.title}</div>
                  </div>
                </Link>
              ) : null}
              <div className="rounded-md border border-line bg-panel2/50 px-3 py-2 text-[10px] text-muted">
                <ShieldCheck className="mr-1 inline size-3 text-teal" />
                执行者不能验收自己的产物。
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Timeline" title="关键时间" />
            <div className="space-y-3 px-5 py-4 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-faint">创建</span>
                <span className="text-muted">{dateTime(task.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">截止</span>
                <span className="text-muted">{dateTime(task.dueAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">最近更新</span>
                <span className="text-muted">{dateTime(task.updatedAt)}</span>
              </div>
            </div>
          </Card>

          {approvals.length > 0 ? (
            <Card className="border-accent/25">
              <CardHeader eyebrow="Approval" title="需要批准" />
              <div className="space-y-2 px-5 py-4">
                {approvals.map((approval) => (
                  <div key={approval.id} className="text-[11px] text-muted">
                    <div className="flex items-center gap-2 text-ink">
                      <CircleAlert className="size-3 text-accent" /> {approval.action}
                    </div>
                    <div className="mt-1">{String(approval.payload.note ?? "")}</div>
                    <Badge tone={approval.status === "pending" ? "accent" : "neutral"} className="mt-2">
                      {approval.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader eyebrow="Audit log" title="审计记录" />
            <div className="divide-y divide-line">
              {audit.slice(0, 5).map((event) => (
                <div key={event.id} className="px-5 py-2.5">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="mono text-muted">{event.action}</span>
                    <span className="text-faint">·</span>
                    <span className="truncate text-faint">{event.actor}</span>
                  </div>
                  <div className="mt-0.5 text-[9px] text-faint">{dateTime(event.createdAt)}</div>
                </div>
              ))}
              {audit.length === 0 ? (
                <div className="px-5 py-4 text-[10px] text-faint">暂无记录。</div>
              ) : null}
            </div>
          </Card>

          <Card>
            <div className="flex items-start gap-3 px-5 py-4">
              <Clock3 className="mt-0.5 size-4 text-blue" />
              <div className="text-[11px] leading-relaxed text-muted">
                运行是可回放的：同一个 <span className="mono text-ink">replayKey</span>{" "}
                可以复现步骤与产物，方便复盘和排查。
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
