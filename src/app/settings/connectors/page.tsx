import type { Metadata } from "next";
import Link from "next/link";
import { CircleSlash, Mail, Search, Sparkles } from "lucide-react";

import {
  CapabilityBadge,
  Card,
  CardHeader,
  SectionTitle,
} from "@/components/ui";
import { ConnectorTestButton } from "@/components/actions";
import { fetchConnectorStatus } from "@/lib/api/pages";
import { money } from "@/lib/format";
import { modelBillingHint } from "@/lib/presentation/connectors-view";

export const metadata: Metadata = {
  title: "连接器 · Cabinet",
  description: "这台部署真的能连到什么：检索、邮件、模型与演示模式。",
};

export const dynamic = "force-dynamic";

export default async function ConnectorsPage() {
  const status = await fetchConnectorStatus();
  const { search, model, email, demoMode, retrieval } = status;

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle
        as="h1"
          title="连接器"
          hint="这里显示的是配置事实，不是愿望。没配就是没配，不会假装能用。"
        />
      </div>

      <Card>
        <CardHeader
          eyebrow="Web search"
          title="检索"
          right={
            <CapabilityBadge
              state={search.configured ? "configured" : "not_configured"}
            />
          }
        />
        <div className="space-y-4 px-5 py-4">
          <Row
            icon={<Search className="size-4 text-muted" aria-hidden />}
            label="主提供方"
            value={search.provider ? providerName(search.provider) : "无"}
            hint={
              search.configured
                ? "研究任务会真的取回网页片段，并写入证据表。"
                : `设置 ${search.envVar ?? "BRAVE_API_KEY"} 后，研究任务才会真的检索。`
            }
          />
          <Row
            icon={<Search className="size-4 text-muted" aria-hidden />}
            label="备用提供方"
            value={
              search.fallbackConfigured && search.fallback
                ? providerName(search.fallback)
                : "无"
            }
            hint="主提供方遇到限流、5xx 或超时才会切换；密钥被拒绝不会切换，以免掩盖配置错误。"
          />
          <Row
            icon={<Search className="size-4 text-muted" aria-hidden />}
            label="每周检索上限"
            value={
              retrieval.budgetCents > 0
                ? money(retrieval.budgetCents)
                : "未设上限"
            }
            hint={
              retrieval.budgetCents > 0
                ? "达到上限后不再发起外部检索，运行记录为「未执行」而不是失败。"
                : "设置 RETRIEVAL_WEEKLY_BUDGET_CENTS 可以给检索加一个每周上限；本周实际花费显示在 Today 页。"
            }
          />
          <div className="border-t border-line/70 pt-4">
            <ConnectorTestButton disabled={!search.configured} />
            <p className="mt-2 text-label text-faint">
              会真的发一次检索请求（固定查询、一条结果）。结果只显示在按钮旁，不落库：刷新页面后回到空闲，不会把五分钟前的成功当成现在。
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Email"
          title="邮件通道"
          right={
            <CapabilityBadge
              state={email.configured ? "configured" : "not_configured"}
            />
          }
        />
        <div className="space-y-4 px-5 py-4">
          <Row
            icon={<Mail className="size-4 text-muted" aria-hidden />}
            label="发件服务器"
            value={
              email.configured
                ? `${email.host}${email.port ? `:${email.port}` : ""} · ${email.from ?? "无发件人"}`
                : "无"
            }
            hint={
              email.configured
                ? `通知先进队列，再由投递进程发出${email.secure ? "（TLS）" : ""}；请求不在网页进程里等 SMTP。`
                : `设置 ${email.envVars.join(" / ")} 后，通知才会真的发出；没配置时只会排队，不会假装已发送。`
            }
          />
          <p className="text-label leading-relaxed text-faint">
            邮件密码不在页面上出现，这里只报配置事实。
            <Link
              href="/settings/notifications"
              className="mx-1 text-accent underline decoration-accent/40 underline-offset-2"
            >
              投递记录
            </Link>
            在通知页。
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Model"
          title="模型"
          right={
            <CapabilityBadge
              state={model.configured ? "configured" : "not_configured"}
            />
          }
        />
        <div className="space-y-4 px-5 py-4">
          <Row
            icon={<Sparkles className="size-4 text-muted" aria-hidden />}
            label="模型"
            value={model.model}
            hint={modelBillingHint(model.provider)}
          />
          <Row
            icon={
              demoMode ? (
                <CircleSlash className="size-4 text-danger" aria-hidden />
              ) : (
                <CircleSlash className="size-4 text-muted" aria-hidden />
              )
            }
            label="演示模式"
            value={demoMode ? "已开启" : "关闭"}
            hint={
              demoMode
                ? "演示模式下产物来自确定性模板，不算真实执行，也不会进入转正证据。"
                : "产物只来自模型；没有模型时任务会失败，而不是退回模板。"
            }
          />
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="What changes" title="配好之后会怎样" />
        <ul className="space-y-2 px-5 py-4 text-label leading-relaxed text-ink-soft">
          <li>· 研究任务的工具步骤会真的执行，记录提供方、耗时、与命中的证据条数。</li>
          <li>· 产物必须带 <code className="rounded bg-sunken px-1">[cite:evd_…]</code> 引用，悬空引用直接判不通过。</li>
          <li>· Auditor 只看取证表里的行，正文里写个链接不算证据。</li>
          <li>
            · 证据可以在
            <Link href="/memory" className="mx-1 text-accent underline decoration-accent/40 underline-offset-2">
              记忆页
            </Link>
            与任务详情里回溯。
          </li>
        </ul>
      </Card>
    </div>
  );
}

function providerName(name: string): string {
  if (name === "brave") return "Brave Search";
  if (name === "tavily") return "Tavily";
  return name;
}

function Row({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-label text-muted">{label}</span>
          <span className="text-body text-ink">{value}</span>
        </div>
        <p className="mt-1 text-label leading-relaxed text-faint">{hint}</p>
      </div>
    </div>
  );
}
