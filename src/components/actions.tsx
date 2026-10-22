"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  FileCheck2,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { Button, Progress } from "@/components/ui";
import { cn } from "@/lib/format";

async function call(
  url: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export function TaskActions({
  taskId,
  status,
}: {
  taskId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(path: string, label: string) {
    setBusy(label);
    setMsg(null);
    const data = await call(path, "POST");
    setBusy(null);
    if (!data.ok) {
      setMsg(data.error ?? "操作失败");
      return;
    }
    setMsg(label === "audit" ? `验收结果：${data.decision === "accepted" ? "通过" : "驳回"}` : "执行完成");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() => run(`/api/tasks/${taskId}/run`, "run")}
        disabled={busy !== null}
      >
        {busy === "run" ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
        {["accepted", "rejected", "done"].includes(status) ? "重新执行" : "执行"}
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => run(`/api/tasks/${taskId}/audit`, "audit")}
        disabled={busy !== null || status !== "submitted"}
      >
        {busy === "audit" ? <Loader2 className="size-3 animate-spin" /> : <FileCheck2 className="size-3" />}
        提交验收
      </Button>
      {msg ? <span className="text-[11px] text-muted">{msg}</span> : null}
      {status === "rejected" ? (
        <span className="text-[10px] text-danger">
          已驳回：先重新执行，再提交验收。
        </span>
      ) : null}
    </div>
  );
}

export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    await call(`/api/approvals/${approvalId}`, "PATCH", {
      decision,
      reason: decision === "reject" ? "用户拒绝" : "用户批准",
    });
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary" onClick={() => decide("approve")} disabled={busy !== null}>
        {busy === "approve" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
        批准
      </Button>
      <Button size="sm" onClick={() => decide("reject")} disabled={busy !== null}>
        <X className="size-3" /> 拒绝
      </Button>
    </div>
  );
}

type InsightDTO = {
  id: string;
  claim: string;
  rationale: string;
  confidence: number;
  evidence: Array<{ label: string; ref?: string; quote?: string }>;
  proposedChange: {
    type: string;
    taskId?: string;
    from?: string;
    to?: string;
    minutes?: number;
    rule?: string;
  };
  status: string;
};

function changeLabel(change: InsightDTO["proposedChange"]): string {
  if (change.type === "reschedule") {
    return `把任务时间 ${change.from ?? "?"} → ${change.to ?? "?"}`;
  }
  if (change.type === "split_task") {
    return `把任务拆到 ${change.minutes ?? 25} 分钟`;
  }
  if (change.type === "add_rule") {
    return `新增规则：${change.rule ?? ""}`;
  }
  return "无变更";
}

export function InsightCard({ insight }: { insight: InsightDTO }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(action: "accept" | "reject" | "rollback") {
    setBusy(action);
    const data = await call(`/api/insights/${insight.id}`, "PATCH", { action });
    setBusy(null);
    if (!data.ok) {
      setMsg(data.error ?? "操作失败");
      return;
    }
    setMsg(action === "accept" ? "已采纳" : action === "reject" ? "已拒绝" : "已回滚");
    router.refresh();
  }

  const tone =
    insight.status === "applied"
      ? "border-teal/25"
      : insight.status === "rejected"
        ? "border-line opacity-70"
        : "border-accent/25";

  return (
    <div className={cn("rounded-xl border bg-panel2/40 p-4", tone)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-accent" />
            <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
              insight · {insight.status}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium leading-relaxed text-ink">
            {insight.claim}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="mono text-lg text-ink">{Math.round(insight.confidence * 100)}%</div>
          <div className="text-[10px] text-faint">confidence</div>
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted">{insight.rationale}</p>

      <div className="mt-3 rounded-lg border border-line bg-panel/60 px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.14em] text-faint">proposed change</div>
        <div className="mt-1 text-xs text-accent">{changeLabel(insight.proposedChange)}</div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {insight.evidence.map((e) => (
          <span
            key={`${e.label}-${e.ref ?? ""}`}
            className="rounded border border-line bg-panel px-2 py-1 text-[10px] text-muted"
            title={e.quote}
          >
            {e.label}
          </span>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {insight.status === "proposed" ? (
          <>
            <Button size="sm" variant="primary" onClick={() => act("accept")} disabled={busy !== null}>
              {busy === "accept" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              采纳
            </Button>
            <Button size="sm" onClick={() => act("reject")} disabled={busy !== null}>
              <X className="size-3" /> 拒绝
            </Button>
          </>
        ) : null}
        {insight.status === "applied" ? (
          <Button size="sm" onClick={() => act("rollback")} disabled={busy !== null}>
            {busy === "rollback" ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
            回滚
          </Button>
        ) : null}
        {msg ? <span className="text-[11px] text-muted">{msg}</span> : null}
      </div>

      <div className="mt-3">
        <Progress value={insight.confidence * 100} tone="accent" />
      </div>
    </div>
  );
}

export function CheckinForm({
  tasks,
}: {
  tasks: Array<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [energy, setEnergy] = useState(3);
  const [mood, setMood] = useState(3);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit() {
    setBusy(true);
    const data = await call("/api/checkin", "POST", {
      energy,
      mood,
      note,
      completed: tasks.map((t) => ({ taskId: t.id, done: Boolean(done[t.id]) })),
    });
    setBusy(false);
    if (data.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-faint">energy</div>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setEnergy(n)}
                className={cn(
                  "h-7 flex-1 rounded border text-[11px] transition-colors",
                  energy === n
                    ? "border-accent/50 bg-accent/15 text-accent"
                    : "border-line bg-panel2 text-muted hover:border-line2",
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-faint">mood</div>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setMood(n)}
                className={cn(
                  "h-7 flex-1 rounded border text-[11px] transition-colors",
                  mood === n
                    ? "border-teal/50 bg-teal/15 text-teal"
                    : "border-line bg-panel2 text-muted hover:border-line2",
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        {tasks.slice(0, 3).map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-panel2/40 px-3 py-2 text-xs text-muted hover:border-line2"
          >
            <input
              type="checkbox"
              checked={Boolean(done[t.id])}
              onChange={(e) => setDone((d) => ({ ...d, [t.id]: e.target.checked }))}
              className="size-3.5 accent-[#e0a83e]"
            />
            <span className="truncate">{t.title}</span>
          </label>
        ))}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="30 秒备注：今天哪里卡住了？"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
      />

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || saved}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          {saved ? "已保存" : "完成 check-in"}
        </Button>
        <span className="text-[10px] text-faint">会写入记忆，供明天使用</span>
      </div>
    </div>
  );
}

export function AutonomyControl({
  agentId,
  level,
}: {
  agentId: string;
  level: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(next: number) {
    setBusy(next);
    setError(null);
    const data = await call(`/api/autonomy/${agentId}`, "PATCH", { level: next });
    setBusy(null);
    if (!data.ok) {
      setError(data.error ?? "升级失败");
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <div className="flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            onClick={() => change(n)}
            disabled={busy !== null}
            className={cn(
              "flex-1 rounded-md border px-2 py-2 text-[11px] transition-colors",
              level === n
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-line bg-panel2 text-muted hover:border-line2",
            )}
          >
            {busy === n ? <Loader2 className="mx-auto size-3 animate-spin" /> : `L${n}`}
          </button>
        ))}
      </div>
      <div className="mt-2 text-[10px] text-faint">
        升级需要：信任分 ≥70 · 成功任务 ≥3 · 非试用期。
      </div>
      {error ? <div className="mt-2 text-[11px] text-danger">{error}</div> : null}
    </div>
  );
}

export function ExamButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const data = await call("/api/apprentice/exam", "POST");
    setBusy(false);
    setResult(data.ok ? `考试通过 ${data.passed}/${data.required}，已转正。` : (data.error ?? "失败"));
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
        运行结业考试
      </Button>
      {result ? <span className="text-[11px] text-muted">{result}</span> : null}
    </div>
  );
}

export function CouncilActions({ councilId }: { councilId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("先买 1 个月试学，设置第 6 天退款提醒。");
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject" | "conditions") {
    setBusy(decision);
    await call(`/api/council/${councilId}`, "PATCH", { decision, note });
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink focus:border-accent/50 focus:outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => decide("approve")} disabled={busy !== null}>
          批准
        </Button>
        <Button size="sm" onClick={() => decide("conditions")} disabled={busy !== null}>
          有条件批准
        </Button>
        <Button size="sm" variant="danger" onClick={() => decide("reject")} disabled={busy !== null}>
          否决
        </Button>
      </div>
    </div>
  );
}

export function ReflectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const data = await call("/api/reflect", "POST");
    setBusy(false);
    setMsg(data.ok ? "已生成新洞察" : (data.error ?? "失败"));
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
        运行反思
      </Button>
      {msg ? <span className="text-[10px] text-muted">{msg}</span> : null}
    </div>
  );
}

export function BriefButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    await call("/api/brief", "POST");
    setBusy(false);
    router.refresh();
  }
  return (
    <Button size="sm" variant="ghost" onClick={run} disabled={busy}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
      重新生成
    </Button>
  );
}
