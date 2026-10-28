import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Brain,
  Clock3,
  GraduationCap,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { fetchAgentPage } from "@/lib/api/pages";
import {
  AUTONOMY_LABELS,
  grantStateLabel,
  grantStateTone,
  passRate,
  roleMeta,
  statusLabel,
} from "@/lib/agents";
import { money, pct, relative, shortDate, timeOnly } from "@/lib/format";
import { memoryTypeLabel } from "@/contracts/labels";
import { sourceLabel } from "@/lib/domain/provenance";
import { completionPercent } from "@/lib/presentation/ratio";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  Progress,
  Stat,
  StatusBadge,
} from "@/components/ui";
import {
  AgentAdmin,
  AutonomyControl,
  ExamButton,
  GraduateButton,
  ObservationRecorder,
  RevokeGrantButton,
} from "@/components/actions";

export const metadata: Metadata = {
  title: "Agent · Cabinet",
};

export const dynamic = "force-dynamic";

export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchAgentPage(id);
  if (!data) notFound();
  const tz = data.timezone;
  const { agent, budget, apprenticeship, memoryTotal, runs, memories, skills, tasks, grants } =
    data;
  // Base permissions describe what the agent may touch; standing policies are
  // the rules the user created by approving once, and can revoke here.
  const standingGrants = grants.filter((grant) => grant.state !== "base");
  const baseGrants = grants.filter((grant) => grant.state === "base");
  const meta = roleMeta(agent.role);
  const rate = passRate(agent.successCount, agent.failCount);
  // Week usage comes from the ledger, never from the frozen agents.spent_cents
  // snapshot: settled is measured-token cost, unknown is unreported exposure.
  const weekUsedCents = budget.settledCents + budget.unknownCents;
  const weekUsedPct =
    budget.limitCents > 0 ? (weekUsedCents / budget.limitCents) * 100 : 0;

  return (
    <div>
      <Link
        href="/cabinet"
        className="mb-5 inline-flex items-center gap-1 text-label text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回内阁
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Avatar initials={agent.avatar} accent={meta.accent} size={52} />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-page font-semibold tracking-tight text-ink">{agent.name}</h1>
              <StatusBadge status={agent.status} />
              {agent.lifecycleStage !== "active" ? (
                <Badge tone="accent">{statusLabel(agent.lifecycleStage)}</Badge>
              ) : null}
              <Link
                href={`/api/agents/${agent.id}/card`}
                target="_blank"
                className="rounded-md border border-line bg-panel2 px-2 py-0.5 text-label text-muted hover:border-line2"
              >
                Agent Card
              </Link>
            </div>
            <div className="mt-1 text-label text-muted">
              {agent.title} · {meta.objective}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-label text-faint">
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
              <p className="text-label leading-relaxed text-ink-soft">{agent.charter}</p>
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Performance"
              title="绩效"
              right={<span className="text-label text-faint">{agent.successCount} 通过 / {agent.failCount} 驳回</span>}
            />
            <div className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-4">
              <Stat label="Trust" value={Math.round(agent.trustScore)} hint="0–100" />
              <Stat label="Pass rate" value={`${rate}%`} hint="验收通过率" />
              <Stat
                label="本周用量"
                value={money(weekUsedCents)}
                hint={`上限 ${money(budget.limitCents)}`}
              />
              <Stat label="Tasks" value={tasks.length} hint="最近任务" />
            </div>
            <div className="space-y-3 border-t border-line px-5 py-4">
              <div>
                <div className="mb-1 flex items-center justify-between text-label text-faint">
                  <span>信任分</span>
                  <span className="mono">{Math.round(agent.trustScore)} / 100</span>
                </div>
                <Progress value={agent.trustScore} tone="teal" label="信任分" />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-label text-faint">
                  <span>本周模型用量（{money(budget.settledCents)} 已结算 + {money(budget.unknownCents)} 未知）</span>
                  <span className="mono">{budget.limitCents > 0 ? pct(weekUsedPct) : "—"}</span>
                </div>
                <Progress
                  value={budget.limitCents > 0 ? weekUsedPct : 0}
                  tone="accent"
                  label="本周模型用量占预算比例"
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-faint">
                  <span className="mono">
                    {shortDate(budget.periodStart, tz)} – {shortDate(budget.periodEnd, tz)}
                  </span>
                  <span>· {budget.timezone}</span>
                  {budget.reservedCents > 0 ? (
                    <span className="text-accent">· 进行中预留 {money(budget.reservedCents)}</span>
                  ) : null}
                  {budget.overrun ? <span className="text-danger">· 已超支</span> : null}
                  {budget.legacyUnclassified ? (
                    <span className="text-accent">· 本周含台账上线前的运行，历史花费未知</span>
                  ) : null}
                </div>
                <p className="mt-1 text-label text-faint">
                  金额由已上报的 token 按配置费率估算，不等同于账单；预算是本周的模型调用额度。
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Runs" title="最近运行" right={<span className="text-label text-faint">可回放</span>} />
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
                    <div className="mono truncate text-label text-ink">{run.id}</div>
                    <div className="mt-0.5 text-label text-faint">
                      {run.taskId} · {run.mode} ·{" "}
                      {run.tokensIn === null || run.tokensOut === null
                        ? "用量未知"
                        : `${run.tokensIn + run.tokensOut} tokens`}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="mono text-label text-muted">{money(run.costCents)}</div>
                    <div className="text-label text-faint">{timeOnly(run.createdAt, tz)}</div>
                  </div>
                </Link>
              ))}
              {runs.length === 0 ? (
                <div className="px-5 py-8 text-center text-label text-faint">还没有运行记录。</div>
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
                        <div className="text-label font-medium text-ink">{skill.name}</div>
                        <div className="mt-0.5 text-label text-faint">
                          v{skill.version} · {skill.label} · {skill.successCount} 通过 / {skill.failCount} 失败
                        </div>
                      </div>
                      <Badge tone={skill.status === "active" ? "teal" : "accent"}>
                        {statusLabel(skill.status)}
                      </Badge>
                    </div>
                    <ol className="mt-3 space-y-1 text-label text-muted">
                      {skill.steps.map((step, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="mono text-faint">{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    {skill.eval ? (
                      <div className="mt-3 rounded-md border border-line bg-panel2/50 px-3 py-2 text-label text-muted">
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
                <div className="mb-3 flex items-center gap-2 text-label text-muted">
                  <GraduationCap className="size-4 text-accent" />
                  影子学习 → 技能草案 → 5 题留出考试 → 转正
                </div>
                {agent.lifecycleStage === "active" ? (
                  <div className="rounded-md border border-teal/25 bg-teal/[0.04] px-3 py-2 text-label text-teal">
                    已转正：技能 v1 已激活，可接单。
                  </div>
                ) : null}
                {agent.lifecycleStage === "practice_passed" ? (
                  <div className="rounded-md border border-violet/25 bg-violet/[0.05] px-3 py-2 text-label text-violet">
                    练习通过：确定性考试只证明练习完成。转正改看真实证据——信任分、成功任务，
                    以及真实运行被验收后的有效审计样本与通过率。
                    <GraduateButton />
                  </div>
                ) : null}
                {apprenticeship ? (
                  <>
                    <div className="mb-2 flex items-center justify-between text-label text-muted">
                      <span>观摩证据</span>
                      <span className="mono">
                        {apprenticeship.observed}/{apprenticeship.required}
                      </span>
                    </div>
                    <Progress
                      label="观摩证据收集进度"
                      value={completionPercent(
                        apprenticeship.observed,
                        apprenticeship.required,
                      )}
                      tone={
                        apprenticeship.observed >= apprenticeship.required
                          ? "teal"
                          : "accent"
                      }
                    />
                    <p className="mt-2 text-label leading-relaxed text-faint">
                      只有 mentor 的真实模型运行、且任务已验收通过，才能被记录为一次观摩；
                      记录满 {apprenticeship.required} 条才能参加考试。
                    </p>
                    {agent.lifecycleStage !== "active" &&
                    agent.lifecycleStage !== "practice_passed" ? (
                      <div className="mt-3">
                        <ObservationRecorder
                          candidates={apprenticeship.candidates}
                          observed={apprenticeship.observed}
                          required={apprenticeship.required}
                        />
                        <div className="mt-3">
                          <ExamButton />
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
                <p className="mt-3 text-label leading-relaxed text-faint">
                  考试由 Auditor 监考；≥4/5 通过。通过只标记练习完成，不改变信任分与授权等级。
                </p>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              eyebrow="Tools & grants"
              title="工具与权限"
              right={
                <Badge tone="neutral">{agent.tools.length} 个工具</Badge>
              }
            />
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-5 py-4 sm:grid-cols-3">
              {agent.tools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 text-label text-muted">
                  <KeyRound className="size-3 shrink-0 text-faint" />
                  <span className="mono truncate">{tool}</span>
                </div>
              ))}
            </div>

            {baseGrants.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-5 py-2.5">
                <span className="text-label text-faint">基础权限</span>
                {baseGrants.map((grant) => (
                  <span
                    key={grant.id}
                    className="mono rounded border border-line/70 px-1.5 py-0.5 text-label text-muted"
                  >
                    {grant.resource}/{grant.scope}
                  </span>
                ))}
                <span className="text-label text-faint">· 来自岗位设定，不可在此撤销</span>
              </div>
            ) : null}

            <div className="border-t border-line px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-label text-ink">长期策略</h3>
                <span className="text-label text-faint">
                  你批准过的同类动作，可随时撤销
                </span>
              </div>
              {standingGrants.length === 0 ? (
                <p className="mt-2 text-label leading-relaxed text-faint">
                  还没有。批准任务时勾选「记住这类决定」，这里就会出现一条有期限、有次数的自动执行规则。
                </p>
              ) : (
                <div className="mt-2 divide-y divide-line/70">
                  {standingGrants.map((grant) => (
                    <div key={grant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <Badge tone={grantStateTone(grant.state)}>
                        {grantStateLabel(grant.state)}
                      </Badge>
                      <span className="mono text-label text-muted">
                        {grant.resource}/{grant.action}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-label text-faint" title={grant.label ?? undefined}>
                        {grant.label ?? "（无说明）"}
                      </span>
                      <span className="text-label text-faint">
                        {grant.maxRuns === null
                          ? `已用 ${grant.useCount} 次`
                          : `已用 ${grant.useCount}/${grant.maxRuns}`}
                        {grant.expiresAt ? ` · 至 ${shortDate(grant.expiresAt, tz)}` : ""}
                        {grant.maxCents !== null ? ` · 单次上限 ${money(grant.maxCents)}` : ""}
                      </span>
                      {grant.state === "active" ? (
                        <RevokeGrantButton grantId={grant.id} label={grant.label ?? grant.resource} />
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Memory scope" title="记忆范围" />
            <div className="flex flex-wrap gap-1.5 px-5 py-4">
              {agent.memoryScope.map((scope) => (
                <Badge key={scope} tone="neutral">{scope}</Badge>
              ))}
            </div>
            <div className="border-t border-line px-5 py-3 text-label text-faint">
              只读取授权范围内的记忆；不共享其他 Agent 的私有上下文。
            </div>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Memories"
              title="它记住的事"
              right={
                // 这个数是它记住的事的总数，不是这一页的长度：卡片只放五条，
                // 查询也最多取八条，拿 memories.length 当总数会把 40 说成 8。
                memoryTotal > memories.slice(0, 5).length ? (
                  <Link
                    href="/memory"
                    className="inline-flex items-center gap-1 text-label text-faint hover:text-muted"
                  >
                    共 {memoryTotal} 条，查看记忆 <ArrowRight className="size-3" />
                  </Link>
                ) : undefined
              }
            />
            <div className="divide-y divide-line">
              {memories.slice(0, 5).map((memory) => (
                <div key={memory.id} className="px-5 py-3">
                  <div className="flex items-start gap-2">
                    <BookOpen className="mt-0.5 size-3 text-faint" />
                    <div className="min-w-0">
                      <div className="text-label leading-relaxed text-muted">{memory.content}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-faint">
                        <span>{memoryTypeLabel(memory.type)}</span>
                        <span>·</span>
                        <span>{Math.round(memory.confidence * 100)}%</span>
                        <span>·</span>
                        <span>{memory.domain}</span>
                        <span>·</span>
                        {/* Same rule as the Memory page: the reader must be able
                            to tell a demo memory from something established. */}
                        <span>{sourceLabel(memory.sourceType)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {memories.length === 0 ? (
                <div className="px-5 py-6 text-center text-label text-faint">暂无记忆。</div>
              ) : null}
            </div>
          </Card>

          {agent.role === "apprentice" ? (
            <Card className="border-violet/20">
              <div className="flex items-start gap-3 px-5 py-4">
                <Sparkles className="mt-0.5 size-4 text-violet" />
                <div className="text-label leading-relaxed text-muted">
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
