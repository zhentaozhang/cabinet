"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  FileCheck2,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UserMinus,
  X,
} from "lucide-react";
import { Button, Progress } from "@/components/ui";
import { browserApi, idempotencyKey } from "@/lib/api/browser";
import { cn } from "@/lib/format";

/**
 * Thin adapter kept for the existing call sites: the transport work (JSON
 * guarding, error codes, idempotency) now lives in the shared API client.
 */
async function call(
  url: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<{ ok: boolean; error?: string; code?: string; [key: string]: unknown }> {
  const result = await browserApi.mutate<Record<string, unknown>>(url, {
    method,
    body,
    idempotencyKey: idempotencyKey(url, body),
  });

  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code };
  }

  return { ok: true, ...result.data };
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
    if (label === "audit") {
      setMsg(`验收结果：${data.decision === "accepted" ? "通过" : "驳回"}`);
    } else if (data.requiresApproval) {
      setMsg("已提交审批，等待你批准");
    } else if (data.suggested) {
      setMsg("L1 只生成建议，已保存草稿");
    } else {
      setMsg("执行完成");
    }
    router.refresh();
  }

  const finished = ["accepted", "done"].includes(status);
  const runnable = ["planned", "assigned", "approved", "rejected"].includes(
    status,
  );
  const runLabel = finished
    ? "已完成"
    : status === "submitted" || status === "auditing"
      ? "待验收"
      : status === "suggested"
        ? "待采纳"
        : status === "awaiting_approval"
          ? "待审批"
          : status === "rejected"
            ? "重新执行"
            : "执行";

  async function promote() {
    setBusy("promote");
    const data = await call(`/api/tasks/${taskId}/promote`, "POST");
    setBusy(null);
    if (!data.ok) {
      setMsg(data.error ?? "采纳失败");
      return;
    }
    setMsg("已采纳建议，可以执行");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "suggested" ? (
        <Button
          size="sm"
          variant="primary"
          onClick={promote}
          disabled={busy !== null}
        >
          {busy === "promote" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          采纳建议
        </Button>
      ) : (
      <Button
        size="sm"
        onClick={() => run(`/api/tasks/${taskId}/run`, "run")}
        disabled={busy !== null || !runnable}
      >
        {busy === "run" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : finished ? (
          <Check className="size-3" />
        ) : (
          <Play className="size-3" />
        )}
        {runLabel}
      </Button>
      )}
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

export function VerifyAuditButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/audit/verify");
    const data = await res.json();
    setBusy(false);
    setMsg(
      data.ok
        ? `链完整 · ${data.checked} 条`
        : `首个不一致：${data.firstMismatch ?? "未知"}`,
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={run} disabled={busy}>
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ShieldCheck className="size-3" />
        )}
        验证审计链
      </Button>
      {msg ? <span className="text-[10px] text-muted">{msg}</span> : null}
    </div>
  );
}

export function AgentAdmin({
  agentId,
  status,
  charter,
  budgetCents,
}: {
  agentId: string;
  status: string;
  charter: string;
  budgetCents: number;
}) {
  const router = useRouter();
  const [draftCharter, setDraftCharter] = useState(charter);
  const [budgetYuan, setBudgetYuan] = useState(String(budgetCents / 100));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setMsg(null);
    const data = await call(`/api/agents/${agentId}`, "PATCH", body);
    setBusy(null);
    setMsg(data.ok ? "已保存" : (data.error ?? "保存失败"));
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {status === "active" ? (
          <Button
            size="sm"
            onClick={() => patch({ status: "paused" }, "pause")}
            disabled={busy !== null}
          >
            <Pause className="size-3" /> 暂停
          </Button>
        ) : null}
        {status === "paused" ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => patch({ status: "active" }, "resume")}
            disabled={busy !== null}
          >
            <Play className="size-3" /> 恢复
          </Button>
        ) : null}
        {status !== "retired" ? (
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (window.confirm("退休后不可恢复。确认？")) {
                patch({ status: "retired" }, "retire");
              }
            }}
            disabled={busy !== null}
          >
            <UserMinus className="size-3" /> 退休
          </Button>
        ) : null}
      </div>

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-faint">
          Charter
        </div>
        <textarea
          value={draftCharter}
          onChange={(event) => setDraftCharter(event.target.value)}
          rows={4}
          className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-[11px] leading-relaxed text-ink focus:border-accent/50 focus:outline-none"
        />
        <Button
          size="sm"
          className="mt-2"
          onClick={() => patch({ charter: draftCharter }, "charter")}
          disabled={busy !== null}
        >
          保存宪章
        </Button>
      </div>

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-faint">
          Weekly budget (¥)
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            value={budgetYuan}
            onChange={(event) => setBudgetYuan(event.target.value)}
            className="h-8 w-24 rounded-md border border-line bg-panel2 px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <Button
            size="sm"
            onClick={() =>
              patch(
                { budgetCents: Math.round(Number(budgetYuan) * 100) },
                "budget",
              )
            }
            disabled={busy !== null}
          >
            保存预算
          </Button>
        </div>
      </div>

      {msg ? <div className="text-[10px] text-muted">{msg}</div> : null}
    </div>
  );
}

export function QuickCreate({
  agents,
  goals,
}: {
  agents: Array<{ id: string; name: string; role: string }>;
  goals: Array<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(
    url: string,
    body: Record<string, unknown>,
    label: string,
  ) {
    setBusy(label);
    setMsg(null);
    const data = await call(url, "POST", body);
    setBusy(null);
    setMsg(data.ok ? "已创建" : (data.error ?? "创建失败"));
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-2">
      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-muted">
          <Plus className="mr-1 inline size-3" /> 新建任务
        </summary>
        <div className="mt-3 space-y-2">
          <input
            id="qc-task-title"
            placeholder="任务标题"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <textarea
            id="qc-task-desc"
            placeholder="描述"
            rows={2}
            className="w-full resize-none rounded border border-line bg-panel px-2 py-1.5 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <textarea
            id="qc-task-criteria"
            placeholder="验收标准"
            rows={2}
            className="w-full resize-none rounded border border-line bg-panel px-2 py-1.5 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              id="qc-task-assignee"
              className="h-8 rounded border border-line bg-panel px-2 text-[11px] text-ink"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <select
              id="qc-task-auditor"
              className="h-8 rounded border border-line bg-panel px-2 text-[11px] text-ink"
            >
              {agents
                .filter((agent) => agent.role === "auditor")
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              id="qc-task-action"
              className="h-8 rounded border border-line bg-panel px-2 text-[11px] text-ink"
            >
              <option value="internal">内部动作</option>
              <option value="external">外部动作</option>
              <option value="spend">支出</option>
            </select>
            <select
              id="qc-task-goal"
              className="h-8 rounded border border-line bg-panel px-2 text-[11px] text-ink"
            >
              <option value="">无目标</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.title}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            onClick={() => {
              const title = (
                document.getElementById("qc-task-title") as HTMLInputElement
              )?.value;
              const description = (
                document.getElementById("qc-task-desc") as HTMLTextAreaElement
              )?.value;
              const criteria = (
                document.getElementById(
                  "qc-task-criteria",
                ) as HTMLTextAreaElement
              )?.value;
              const assigneeId = (
                document.getElementById(
                  "qc-task-assignee",
                ) as HTMLSelectElement
              )?.value;
              const auditorId = (
                document.getElementById(
                  "qc-task-auditor",
                ) as HTMLSelectElement
              )?.value;
              const actionType = (
                document.getElementById("qc-task-action") as HTMLSelectElement
              )?.value;
              const goalId = (
                document.getElementById("qc-task-goal") as HTMLSelectElement
              )?.value;
              submit(
                "/api/tasks",
                {
                  title,
                  description,
                  acceptanceCriteria: criteria,
                  assigneeId,
                  auditorId,
                  actionType,
                  resource: actionType === "external" ? "calendar" : "task",
                  goalId: goalId || null,
                  estimateMin: 25,
                },
                "task",
              );
            }}
          >
            创建任务
          </Button>
        </div>
      </details>

      <details className="rounded-md border border-line bg-panel2/40 px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-muted">
          <Plus className="mr-1 inline size-3" /> 新建目标
        </summary>
        <div className="mt-3 space-y-2">
          <input
            id="qc-goal-title"
            placeholder="目标标题"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <input
            id="qc-goal-why"
            placeholder="为什么（一句话）"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <input
            id="qc-goal-target"
            placeholder="可验收的目标"
            className="h-8 w-full rounded border border-line bg-panel px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              id="qc-goal-horizon"
              defaultValue="6 weeks"
              className="h-8 rounded border border-line bg-panel px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
            />
            <select
              id="qc-goal-domain"
              className="h-8 rounded border border-line bg-panel px-2 text-[11px] text-ink"
            >
              <option value="learning">学习</option>
              <option value="health">健康</option>
              <option value="work">工作</option>
              <option value="life">生活</option>
            </select>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            onClick={() => {
              const get = (id: string) =>
                (document.getElementById(id) as HTMLInputElement)?.value ?? "";
              submit(
                "/api/goals",
                {
                  title: get("qc-goal-title"),
                  why: get("qc-goal-why"),
                  target: get("qc-goal-target"),
                  horizon: get("qc-goal-horizon"),
                  domain: get("qc-goal-domain"),
                },
                "goal",
              );
            }}
          >
            创建目标
          </Button>
        </div>
      </details>

      {msg ? <div className="text-[10px] text-muted">{msg}</div> : null}
    </div>
  );
}

export function NewCouncilForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    const topic = (document.getElementById("nc-topic") as HTMLInputElement)?.value;
    const trigger = (document.getElementById("nc-trigger") as HTMLInputElement)?.value;
    setBusy(true);
    const data = await call("/api/councils", "POST", { topic, trigger });
    setBusy(false);
    setMsg(data.ok ? "已发起" : (data.error ?? "失败"));
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-2">
      <input
        id="nc-topic"
        placeholder="议题"
        className="h-8 w-full rounded border border-line bg-panel2 px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
      />
      <input
        id="nc-trigger"
        placeholder="触发条件（如：单笔支出 > ¥200）"
        className="h-8 w-full rounded border border-line bg-panel2 px-2 text-[11px] text-ink focus:border-accent/50 focus:outline-none"
      />
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        发起会议
      </Button>
      {msg ? <div className="text-[10px] text-muted">{msg}</div> : null}
    </div>
  );
}
