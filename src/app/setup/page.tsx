import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { getPageUserId, hasWorkspace } from "@/lib/auth/context";
import { AGENT_TEMPLATES } from "@/lib/templates";
import { SetupForm } from "@/components/setup-form";
import { Badge, Card, CardHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const userId = await getPageUserId({ allowMissingWorkspace: true });
  const ready = await hasWorkspace(userId);

  if (ready) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <Card>
          <CardHeader
            eyebrow="Workspace"
            title="你的内阁已经就绪"
            right={<ShieldCheck className="size-4 text-teal" />}
          />
          <div className="px-6 py-5">
            <p className="text-xs leading-relaxed text-muted">
              当前账号已经有 profile 与 Agent。直接进入 Today 开始管理。
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-3 py-1.5 text-[11px] text-ink hover:border-line2/80"
            >
              进入 Today <ArrowRight className="size-3" />
            </Link>
          </div>
        </Card>
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
