import type { Metadata } from "next";
import Link from "next/link";
import { Plug } from "lucide-react";

import { Card, CardHeader, SectionTitle } from "@/components/ui";

export const metadata: Metadata = {
  title: "设置 · Cabinet",
  description: "连接器、演示模式与部署状态。",
};

const SECTIONS = [
  {
    href: "/settings/connectors",
    icon: Plug,
    title: "连接器",
    body: "检索与模型的配置状态，以及一次真实的连通测试。",
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <SectionTitle title="设置" hint="部署层面的开关。产品行为不藏在这里。" />
      <Card>
        <CardHeader eyebrow="Deployment" title="可配置项" />
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
