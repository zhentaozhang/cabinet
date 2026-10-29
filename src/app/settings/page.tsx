import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  CircleSlash,
  Cpu,
  Mail,
  Plug,
  Search,
} from "lucide-react";

import {
  Badge,
  CapabilityBadge,
  Card,
  CardHeader,
  SectionTitle,
} from "@/components/ui";
import { fetchConnectorStatus } from "@/lib/api/pages";
import { modelMissingHint } from "@/lib/presentation/connectors-view";

export const metadata: Metadata = {
  title: "设置 · Cabinet",
  description: "连接器、通知与部署能力状态：哪些已配置，没配会怎样。",
};

export const dynamic = "force-dynamic";

const SECTIONS = [
  {
    href: "/settings/connectors",
    icon: Plug,
    title: "连接器",
    body: "检索与模型的配置状态，以及一次真实的连通测试。",
  },
  {
    href: "/settings/notifications",
    icon: Bell,
    title: "通知",
    body: "异常邮件发到哪、静默时段，以及每一次投递的结果。",
  },
];

const OWNER_DEPLOY = "由部署管理员在环境变量中配置，页面内无法修改。";

export default async function SettingsPage() {
  const status = await fetchConnectorStatus();
  const { search, model, email, demoMode } = status;

  return (
    <div className="space-y-5">
      <SectionTitle
        as="h1"
        title="设置"
        hint="这里显示配置事实与影响：哪些能力已配置、由谁负责、没配时功能会怎样表现。"
      />

      <Card>
        <CardHeader eyebrow="Capabilities" title="当前部署能做什么" />
        <ul className="divide-y divide-line/70">
          <CapabilityRow
            icon={<Cpu className="size-4 text-muted" aria-hidden />}
            title="模型推理"
            badge={
              <CapabilityBadge
                state={model.configured ? "configured" : "not_configured"}
              />
            }
            detail={
              model.configured ? (
                <span className="mono">
                  {model.provider} / {model.model}
                </span>
              ) : (
                modelMissingHint(demoMode, model.envVar)
              )
            }
            owner={OWNER_DEPLOY}
            href="/settings/connectors"
            action="连接器与测试"
          />

          <CapabilityRow
            icon={<Search className="size-4 text-muted" aria-hidden />}
            title="网页检索"
            badge={
              <CapabilityBadge
                state={search.configured ? "configured" : "not_configured"}
              />
            }
            detail={
              <>
                {search.configured ? (
                  <>当前提供方：{providerName(search.provider)}。</>
                ) : (
                  <>
                    研究类任务不会取回真实来源，证据表保持为空，页面不会显示虚假引用。需要设置{" "}
                    <code className="mono text-ink">
                      {search.envVar ?? "BRAVE_API_KEY"}
                    </code>
                    。
                  </>
                )}
                {search.fallbackConfigured && search.fallback ? (
                  <span className="mt-1 block text-faint">
                    备用提供方：{search.fallback}（主提供方限流/5xx/超时才切换）
                  </span>
                ) : null}
              </>
            }
            owner={OWNER_DEPLOY}
            href="/settings/connectors"
            action="连接器与测试"
          />

          <CapabilityRow
            icon={<Mail className="size-4 text-muted" aria-hidden />}
            title="邮件通知"
            badge={
              <CapabilityBadge
                state={email.configured ? "configured" : "not_configured"}
              />
            }
            detail={
              email.configured ? (
                <span className="mono">
                  {email.host ?? "已配置"}
                  {email.port ? `:${email.port}` : ""}
                </span>
              ) : (
                <>
                  异常与审批提醒不会发出，通知页只会显示历史记录。需要设置{" "}
                  <code className="mono text-ink">
                    {email.envVars.join("、")}
                  </code>
                  。
                </>
              )
            }
            owner={OWNER_DEPLOY}
            href="/settings/notifications"
            action="通知与投递记录"
          />

          <CapabilityRow
            icon={<CircleSlash className="size-4 text-muted" aria-hidden />}
            title="演示模式"
            badge={
              demoMode ? (
                <CapabilityBadge state="simulated" />
              ) : (
                <Badge tone="neutral">关闭</Badge>
              )
            }
            detail={
              demoMode
                ? "页面使用种子数据，不是真实执行结果。"
                : "页面数据来自真实执行结果，不使用种子数据。"
            }
            owner="由部署管理员通过环境变量 DEMO_MODE 控制，页面内无法修改。"
          />
        </ul>
        <p className="border-t border-line/70 px-5 py-3 text-label leading-relaxed text-faint">
          设置页只反映配置事实。未配置的能力不会在别处假装可用——相关任务会明确显示未连接状态。
        </p>
      </Card>

      <Card>
        <CardHeader eyebrow="Deployment" title="详情与测试" />
        <ul className="divide-y divide-line/70">
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-panel-hover/40"
              >
                <section.icon className="mt-0.5 size-4 text-muted" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-body text-ink">{section.title}</span>
                  <span className="mt-1 block text-label leading-relaxed text-faint">
                    {section.body}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function providerName(name: string | null): string {
  if (!name) return "已配置";
  if (name === "brave") return "Brave Search";
  if (name === "tavily") return "Tavily";
  return name;
}

function CapabilityRow({
  icon,
  title,
  badge,
  detail,
  owner,
  href,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  badge: React.ReactNode;
  detail: React.ReactNode;
  owner: string;
  href?: string;
  action?: string;
}) {
  return (
    <li className="flex items-start gap-3 px-5 py-4">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body text-ink">{title}</span>
          {badge}
        </div>
        <div className="mt-1 text-label leading-relaxed text-muted">{detail}</div>
        <p className="mt-1 text-label text-faint">{owner}</p>
      </div>
      {href && action ? (
        <Link
          href={href}
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-label font-medium text-accent hover:underline"
        >
          {action}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
    </li>
  );
}
