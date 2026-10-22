"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, CardHeader } from "@/components/ui";

type AgentPreview = {
  role: string;
  name: string;
  title: string;
  objective: string;
};

export function SetupForm({ agents }: { agents: AgentPreview[] }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        timezone,
        ...(title.trim() && target.trim()
          ? {
              goal: {
                title,
                why,
                target,
                horizon: "6 weeks",
                domain: "learning",
              },
            }
          : {}),
      }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok || !data.ok) {
      setError(data.error ?? "创建失败");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="grid gap-5 md:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <CardHeader eyebrow="Step 1" title="基础设置" />
        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-[0.16em] text-faint">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink"
            >
              <option value="Asia/Shanghai">Asia/Shanghai</option>
              <option value="Asia/Tokyo">Asia/Tokyo</option>
              <option value="Europe/London">Europe/London</option>
              <option value="America/New_York">America/New_York</option>
              <option value="UTC">UTC</option>
            </select>
          </div>

          <div className="border-t border-line pt-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-faint">
              Optional first goal
            </div>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="目标标题（可跳过）"
              className="mb-2 h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <input
              value={why}
              onChange={(event) => setWhy(event.target.value)}
              placeholder="为什么"
              className="mb-2 h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="可验收的目标"
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/[0.05] px-3 py-2 text-[11px] text-danger">
              {error}
            </div>
          ) : null}

          <Button
            variant="primary"
            className="w-full"
            onClick={submit}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ShieldCheck className="size-3" />
            )}
            创建内阁
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Step 2"
          title="默认内阁"
          right={<Badge tone="teal">{agents.length} agents</Badge>}
        />
        <div className="divide-y divide-line">
          {agents.map((agent) => (
            <div key={agent.role} className="px-5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink">{agent.name}</span>
                <span className="text-[9px] text-faint">{agent.title}</span>
              </div>
              <div className="mt-0.5 text-[9px] text-faint">{agent.objective}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
