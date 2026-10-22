"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { API_ROUTES } from "@/contracts";
import { browserApi, idempotencyKey } from "@/lib/api/browser";

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
    const body = {
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
    };
    const result = await browserApi.mutate(API_ROUTES.setup, {
      method: "POST",
      body,
      idempotencyKey: idempotencyKey(API_ROUTES.setup, body),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="grid gap-5 md:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <CardHeader eyebrow="Step 1" title="基础设置" />
        <form
          className="space-y-3 px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <label
              htmlFor="setup-timezone"
              className="mb-1.5 block text-mini uppercase tracking-[0.16em] text-faint"
            >
              Timezone
            </label>
            <select
              id="setup-timezone"
              name="timezone"
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
            <div className="mb-2 text-mini uppercase tracking-[0.16em] text-faint">
              Optional first goal
            </div>
            <label htmlFor="setup-goal-title" className="sr-only">
              目标标题
            </label>
            <input
              id="setup-goal-title"
              name="goalTitle"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="目标标题（可跳过）"
              className="mb-2 h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <label htmlFor="setup-goal-why" className="sr-only">
              为什么
            </label>
            <input
              id="setup-goal-why"
              name="goalWhy"
              value={why}
              onChange={(event) => setWhy(event.target.value)}
              placeholder="为什么"
              className="mb-2 h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <label htmlFor="setup-goal-target" className="sr-only">
              可验收的目标
            </label>
            <input
              id="setup-goal-target"
              name="goalTarget"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="可验收的目标"
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/[0.05] px-3 py-2 text-micro text-danger">
              {error}
            </div>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ShieldCheck className="size-3" />
            )}
            创建内阁
          </Button>
        </form>
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
                <span className="text-micro text-ink">{agent.name}</span>
                <span className="text-nano text-faint">{agent.title}</span>
              </div>
              <div className="mt-0.5 text-nano text-faint">{agent.objective}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
