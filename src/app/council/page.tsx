import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  Clock3,
  Gavel,
  Scale,
  ShieldCheck,
  Users,
} from "lucide-react";
import { fetchCouncilPage } from "@/lib/api/pages";
import { roleMeta, stanceLabel, stanceTone } from "@/lib/agents";
import { dateTime } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  StatusBadge,
} from "@/components/ui";
import { CouncilActions, NewCouncilForm } from "@/components/actions";
import { Markdown } from "@/components/markdown";

export const metadata: Metadata = {
  title: "Council · Cabinet",
};

export const dynamic = "force-dynamic";

export default async function CouncilPage() {
  const data = await fetchCouncilPage();
  if (!data) {
    return (
      <div className="mx-auto max-w-xl py-12">
        <EmptyState
          icon={<Gavel className="size-4" />}
          title="没有进行中的内阁会议"
          hint="自动触发（支出、时间冲突、目标变更）尚未接入。你可以在下方手动发起一场会议。"
        />
        <Card className="mt-4">
          <CardHeader eyebrow="Manual" title="发起一场会议" />
          <div className="px-5 py-4">
            <NewCouncilForm />
          </div>
        </Card>
      </div>
    );
  }
  const { council, positions, agents } = data;
  const tz = data.timezone;
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const support = positions.filter((p) => p.stance === "support").length;
  const oppose = positions.filter((p) => p.stance === "oppose").length;

  return (
    <div>
      <Link
        href="/"
        className="mb-5 inline-flex items-center gap-1 text-label text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回今日
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="violet">
              <Gavel className="size-2.5" /> Council
            </Badge>
            <StatusBadge status={council.status} />
            <span className="text-label text-faint">触发：{council.trigger}</span>
          </div>
          <h1 className="text-page font-semibold tracking-tight text-ink">{council.topic}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-label text-faint">
            <span className="inline-flex items-center gap-1">
              <Users className="size-3" /> {positions.length} 位 Agent 提交立场
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock3 className="size-3" /> {dateTime(council.createdAt, tz)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="neutral" title="当前立场由确定性规则生成，不是独立模型研究">
            规则生成
          </Badge>
          <Badge tone="teal">{support} 支持</Badge>
          <Badge tone="danger">{oppose} 反对</Badge>
          <Badge tone="neutral">{positions.length - support - oppose} 中立</Badge>
        </div>
      </div>

      {council.matrix ? (
        <Card className="mb-5">
          <CardHeader
            eyebrow="Matrix"
            title="内阁矩阵"
            right={
              <span className="text-label text-faint">
                综合健康度 {council.matrix.overall} / 100
              </span>
            }
          />
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-4">
            {(
              [
                ["feasibility", "可行性"],
                ["costEfficiency", "成本效率"],
                ["evidenceQuality", "证据质量"],
                ["robustness", "抗风险"],
              ] as const
            ).map(([key, label]) => {
              const value = council.matrix!.dimensions[key];
              return (
                <div
                  key={key}
                  className="rounded-md border border-line bg-panel2/40 px-3 py-2"
                >
                  <div className="text-eyebrow uppercase tracking-wider text-faint">
                    {label}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${value}%` }}
                      />
                    </div>
                    <span className="w-7 text-right text-label text-muted">
                      {value}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
            <Badge tone="teal">{council.matrix.support} 支持</Badge>
            <Badge tone="danger">{council.matrix.oppose} 反对</Badge>
            <Badge tone="neutral">{council.matrix.neutral} 中立</Badge>
            {council.matrix.consensus === "split" ? (
              <Badge tone="violet">内阁分裂，需要你裁决</Badge>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              eyebrow="Positions"
              title="各方立场"
              right={
                <span className="text-label text-faint">每位成员一条立场 · 一次生成</span>
              }
            />
            <div className="divide-y divide-line">
              {positions.map((position) => {
                const agent = agentById.get(position.agentId);
                const meta = agent ? roleMeta(agent.role) : null;
                return (
                  <div key={position.id} className="px-5 py-4">
                    <div className="flex items-start gap-3">
                      <Avatar
                        initials={agent?.avatar ?? "??"}
                        accent={meta?.accent ?? "#8b95a7"}
                        size={30}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-label font-medium text-ink">
                            {agent?.name ?? position.agentId}
                          </span>
                          <Badge tone={stanceTone(position.stance)}>
                            {stanceLabel(position.stance)}
                          </Badge>
                          {position.isDissent ? (
                            <Badge tone="danger">正式异议</Badge>
                          ) : null}
                          <span className="text-label text-faint">
                            {agent?.title ?? ""}
                          </span>
                        </div>
                        <p className="mt-2 text-label leading-relaxed text-ink-soft">
                          {position.claim}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {position.evidence.map((e) => (
                            <span
                              key={`${e.label}-${e.ref ?? ""}`}
                              title={e.quote}
                              className="rounded border border-line bg-panel px-1.5 py-0.5 text-label text-muted"
                            >
                              {e.label}
                            </span>
                          ))}
                        </div>
                        {position.scores ? (
                          <div className="mt-2 flex flex-wrap gap-2 text-label text-faint">
                            <span>可行性 {position.scores.feasibility}</span>
                            <span>成本 {position.scores.costEfficiency}</span>
                            <span>证据 {position.scores.evidenceQuality}</span>
                            <span>抗风险 {position.scores.robustness}</span>
                          </div>
                        ) : null}
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-md border border-line bg-panel2/40 px-2.5 py-2">
                            <div className="text-eyebrow uppercase tracking-wider text-faint">Risk</div>
                            <div className="mt-0.5 text-label text-muted">{position.risk}</div>
                          </div>
                          <div className="rounded-md border border-line bg-panel2/40 px-2.5 py-2">
                            <div className="text-eyebrow uppercase tracking-wider text-faint">Recommendation</div>
                            <div className="mt-0.5 text-label text-accent">{position.recommendation}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Memo" title="决策备忘录" right={<Scale className="size-3.5 text-violet" />} />
            <div className="px-5 py-4">
              <Markdown content={council.memo} />
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className={council.status === "open" ? "border-accent/30" : "border-teal/25"}>
            <CardHeader
              eyebrow="Your call"
              title={council.status === "open" ? "轮到你决定" : "已决议"}
            />
            <div className="px-5 py-4">
              {council.status === "open" ? (
                <CouncilActions councilId={council.id} />
              ) : council.resolution ? (
                <div className="space-y-2 text-label leading-relaxed text-muted">
                  <div className="text-ink">
                    {council.resolution.decision === "approve"
                      ? "批准"
                      : council.resolution.decision === "reject"
                        ? "否决"
                        : "有条件批准"}
                    {council.resolution.note
                      ? `：${council.resolution.note}`
                      : ""}
                  </div>
                  <div>
                    {council.resolution.taskId
                      ? "已生成跟进任务；"
                      : "未生成跟进任务；"}
                    已写入程序记忆。
                  </div>
                  {council.resolution.dissents.length > 0 ? (
                    <div className="text-danger">
                      {council.resolution.dissents.length} 条正式异议已归档。
                    </div>
                  ) : null}
                  <div className="text-label text-faint">
                    决定已记录在审计日志；下次遇到类似议题会作为判例。
                  </div>
                </div>
              ) : (
                <div className="text-label text-muted">
                  决定已记录在审计日志；下次遇到类似议题会作为判例。
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="New" title="发起新会议" />
            <div className="px-5 py-4">
              <NewCouncilForm />
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="Rules" title="会议规则" />
            <div className="space-y-2 px-5 py-4 text-label leading-relaxed text-muted">
              <p>① 只在高风险决策时召开，不替代日常执行。</p>
              <p>② 每个 Agent 必须给证据，不允许只给观点。</p>
              <p>③ Critic 必须唱反调，否则会议无效。</p>
              <p>④ Auditor 只旁听，不投票；验收时独立判断。</p>
              <p>⑤ 你有一票否决权，但必须留下理由。</p>
            </div>
          </Card>

          <Card>
            <div className="flex items-start gap-3 px-5 py-4">
              <ShieldCheck className="mt-0.5 size-4 text-teal" />
              <div className="text-label leading-relaxed text-muted">
                内阁会议是未来 Agent 社区的治理缩微版：身份、立场、证据、投票、异议、判例。
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
