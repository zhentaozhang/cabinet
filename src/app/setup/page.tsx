import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Database, UserRound } from "lucide-react";
import { AGENT_TEMPLATES } from "@/contracts/templates";
import { fetchShellContext, fetchWorkspaceReady } from "@/lib/api/pages";
import { SetupForm } from "@/components/setup-form";
import { Badge, Card, CardHeader } from "@/components/ui";
import { DataControls } from "@/components/data-controls";

export const metadata: Metadata = {
  title: "设置 · Cabinet",
};

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const ready = await fetchWorkspaceReady();

  if (ready) {
    const context = await fetchShellContext();
    return (
      <div className="mx-auto max-w-2xl py-10">
        <div className="mb-6">
          <Badge tone="teal">Workspace</Badge>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
            设置
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            账号、内阁规模和数据的出口都在这里。改动即时生效，审计链会记录关键变更。
          </p>
        </div>

        <Card className="mb-5">
          <CardHeader
            eyebrow="Identity"
            title="账号与工作区"
            right={<UserRound className="size-4 text-teal" />}
          />
          <div className="divide-y divide-line">
            <div className="flex items-center justify-between px-5 py-3">
              <span className="text-micro text-faint">名称</span>
              <span className="text-micro text-ink">{context.name}</span>
            </div>
            <div className="flex items-center justify-between px-5 py-3">
              <span className="text-micro text-faint">登录邮箱</span>
              <span className="mono text-micro text-ink">{context.email}</span>
            </div>
            <div className="flex items-center justify-between px-5 py-3">
              <span className="text-micro text-faint">内阁规模</span>
              <span className="text-micro text-ink">{context.agents} 个 Agent</span>
            </div>
            <div className="flex items-center justify-between gap-4 px-5 py-3">
              <span className="text-micro text-faint">自主阶梯</span>
              <span className="flex flex-wrap gap-1.5">
                <Badge tone="neutral">L1 · {context.autonomy.l1}</Badge>
                <Badge tone="accent">L2 · {context.autonomy.l2}</Badge>
                <Badge tone="teal">L3 · {context.autonomy.l3}</Badge>
              </span>
            </div>
          </div>
        </Card>

        <Card className="mb-5">
          <CardHeader
            eyebrow="Data"
            title="数据"
            right={<Database className="size-4 text-blue" />}
          />
          <div className="px-5 py-4">
            <p className="mb-3 text-xs leading-relaxed text-muted">
              导出一份 JSON 备份，或彻底删除这个账号。删除前建议先导出。
            </p>
            <DataControls />
          </div>
        </Card>

        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-micro text-ink transition-colors hover:border-line2/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          返回 Today <ArrowRight className="size-3" />
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="mb-6">
        <Badge tone="accent">Setup</Badge>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
          创建你的个人内阁
        </h1>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          一次创建 7 个 Agent：Chief / Researcher / Coach / Treasurer / Auditor / Apprentice / Critic。
          之后可以暂停、退休或修改宪章。
        </p>
      </div>
      <SetupForm
        agents={AGENT_TEMPLATES.map((agent) => ({
          role: agent.role,
          name: agent.name,
          title: agent.title,
          objective: agent.objective,
        }))}
      />
    </div>
  );
}
