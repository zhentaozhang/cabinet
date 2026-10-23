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
  Upload,
  X,
} from "lucide-react";
import { Button, Progress } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import type { InsightDto } from "@/contracts";
import { cn } from "@/lib/format";
import { call } from "./shared";

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
      toast.error(data.error ?? "操作失败");
      return;
    }
    if (label === "audit") {
      const isAccepted = data.decision === "accepted";
      const txt = `验收结果：${isAccepted ? "通过" : "驳回"}`;
      setMsg(txt);
      if (isAccepted) {
        toast.success(txt);
      } else {
        toast.error(txt);
      }
    } else if (data.requiresApproval) {
      setMsg("已提交审批，等待你批准");
      toast.info("已提交审批，等待你批准");
    } else if (data.suggested) {
      setMsg("L1 只生成建议，已保存草稿");
      toast.info("L1 只生成建议，已保存草稿");
    } else {
      setMsg("执行完成");
      toast.success("执行完成");
    }
    router.refresh();
  }

  const finished = status === "done";
  const canMarkDone = status === "accepted";
  const runnable = [
    "planned",
    "assigned",
    "approved",
    "rejected",
    "failed",
  ].includes(status);
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

  async function markDone() {
    setBusy("done");
    setMsg(null);
    const data = await call(`/api/tasks/${taskId}/done`, "POST");
    setBusy(null);
    if (!data.ok) {
      setMsg(data.error ?? "操作失败");
      toast.error(data.error ?? "操作失败");
      return;
    }
    setMsg("任务已完成");
    toast.success("任务已完成");
    router.refresh();
  }

  async function promote() {
    setBusy("promote");
    const data = await call(`/api/tasks/${taskId}/promote`, "POST");
    setBusy(null);
    if (!data.ok) {
      setMsg(data.error ?? "采纳失败");
      toast.error(data.error ?? "采纳失败");
      return;
    }
    setMsg("已采纳建议，可以执行");
    toast.success("已采纳建议，可以执行");
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
      {canMarkDone ? (
        <Button
          size="sm"
          variant="primary"
          onClick={markDone}
          disabled={busy !== null}
        >
          {busy === "done" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          标记完成
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="primary"
        onClick={() => run(`/api/tasks/${taskId}/audit`, "audit")}
        disabled={busy !== null || status !== "submitted"}
      >
        {busy === "audit" ? <Loader2 className="size-3 animate-spin" /> : <FileCheck2 className="size-3" />}
        提交验收
      </Button>
      {msg ? <span className="text-label text-muted">{msg}</span> : null}
      {status === "rejected" ? (
        <span className="text-label text-danger">
          已驳回：先重新执行，再提交验收。
        </span>
      ) : null}
    </div>
  );
}

export function ApprovalActions({
  approvalId,
  actionType = "",
}: {
  approvalId: string;
  actionType?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Optimistic: the button area flips to the decision immediately and rolls
   * back if the server refuses. Only safe because the decision is the whole
   * visible state of this widget.
   */
  const [settled, setSettled] = useState<string | null>(null);
  /** 记住这类决定。Off by default: asking every time is the safe default. */
  const [remember, setRemember] = useState(false);
  const [days, setDays] = useState(30);
  const [maxCents, setMaxCents] = useState(5_000);
  const isSpend = actionType === "spend";
  /**
   * `admin` and `audit` may never become standing policy — the server rejects
   * them, and an unset actionType is unknown, so the checkbox is only offered
   * where the decision can actually be delegated.
   */
  const delegable =
    actionType !== "" && actionType !== "admin" && actionType !== "audit";
  const maxCentsValid = !isSpend || maxCents >= 100;

  const effectiveRemember = remember && delegable && maxCentsValid;

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setSettled(decision === "approve" ? "已批准" : "已拒绝");
    const data = await call(`/api/approvals/${approvalId}`, "PATCH", {
      decision,
      reason: decision === "reject" ? "用户拒绝" : "用户批准",
      ...(decision === "approve" && effectiveRemember
        ? {
            remember: {
              days,
              maxRuns: 20,
              ...(isSpend ? { maxCents } : {}),
            },
          }
        : {}),
    });
    setBusy(null);
    if (!data.ok) {
      setSettled(null);
      toast.error(data.error ?? "审批失败");
      return;
    }
    toast.success(
      decision === "approve"
        ? effectiveRemember
          ? `已批准，并在 ${days} 天内自动执行同类动作`
          : "已批准外部动作"
        : "已拒绝动作",
    );
    router.refresh();
  }

  if (settled) {
    return (
      <div className="flex items-center gap-2 text-label text-muted" aria-live="polite">
        <span>{settled}</span>
        <span className="text-faint">· 同步中</span>
      </div>
    );
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
      {delegable ? (
      <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-label text-faint">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          className="size-3 accent-accent"
        />
        记住这类决定
      </label>
      ) : null}

      {remember && delegable ? (
        <div className="flex flex-wrap items-center gap-2 text-label text-faint">
          <label className="flex items-center gap-1">
            有效
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              aria-label="记住多少天"
              className="rounded border border-line bg-panel px-1.5 py-0.5 text-label text-ink"
            >
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </select>
          </label>
          {isSpend ? (
            <label className="flex items-center gap-1">
              单次上限 ¥
              <input
                type="number"
                min={0}
                step={10}
                value={Math.round(maxCents / 100)}
                onChange={(event) => {
                  const yuan = Number(event.target.value);
                  // An empty field must not silently mean "no ceiling at all".
                  setMaxCents(
                    Number.isFinite(yuan) && yuan > 0
                      ? Math.round(yuan * 100)
                      : 0,
                  );
                }}
                aria-label="单次金额上限（元）"
                className="w-16 rounded border border-line bg-panel px-1.5 py-0.5 text-label text-ink"
              />
            </label>
          ) : null}
          <span>最多 20 次</span>
          {maxCentsValid ? null : (
            <span role="alert" className="text-danger">
              请填写至少 ¥1 的单次上限
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function changeLabel(change: InsightDto["proposedChange"]): string {
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

export function InsightCard({ insight }: { insight: InsightDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /**
   * Optimistic status so the card's own chrome (border, buttons, label) reacts
   * on click instead of after a full re-render of the page.
   */
  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
  const status = optimisticStatus ?? insight.status;

  async function act(action: "accept" | "reject" | "rollback") {
    setBusy(action);
    setOptimisticStatus(
      action === "accept" ? "applied" : action === "reject" ? "rejected" : "proposed",
    );
    const data = await call(`/api/insights/${insight.id}`, "PATCH", { action });
    setBusy(null);
    if (!data.ok) {
      setOptimisticStatus(null);
      setMsg(data.error ?? "操作失败");
      toast.error(data.error ?? "操作失败");
      return;
    }
    const label = action === "accept" ? "已采纳" : action === "reject" ? "已拒绝" : "已回滚";
    setMsg(label);
    toast.success(label);
    router.refresh();
  }

  const tone =
    status === "applied"
      ? "border-teal/25"
      : status === "rejected"
        ? "border-line opacity-70"
        : "border-accent/25";

  return (
    <div className={cn("rounded-xl border bg-panel2/40 p-4", tone)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-accent" />
            <span className="text-eyebrow uppercase tracking-[0.16em] text-faint">
              insight · {status}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium leading-relaxed text-ink">
            {insight.claim}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="mono text-lg text-ink">{Math.round(insight.confidence * 100)}%</div>
          <div className="text-label text-faint">confidence</div>
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted">{insight.rationale}</p>

      <div className="mt-3 rounded-lg border border-line bg-panel/60 px-3 py-2">
        <div className="text-eyebrow uppercase tracking-[0.14em] text-faint">proposed change</div>
        <div className="mt-1 text-xs text-accent">{changeLabel(insight.proposedChange)}</div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {insight.evidence.map((e) => (
          <span
            key={`${e.label}-${e.ref ?? ""}`}
            className="rounded border border-line bg-panel px-2 py-1 text-label text-muted"
            title={e.quote}
          >
            {e.label}
          </span>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {status === "proposed" ? (
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
        {msg ? <span className="text-label text-muted">{msg}</span> : null}
      </div>

      <div className="mt-3">
        <Progress value={insight.confidence * 100} tone="accent" />
      </div>
    </div>
  );
}

export function ArtifactSubmitForm({
  taskId,
  status,
  actionType,
}: {
  taskId: string;
  status: string;
  actionType: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (
    actionType !== "internal" ||
    !["planned", "assigned", "submitted", "rejected"].includes(status)
  ) {
    return null;
  }

  async function submit() {
    setBusy(true);
    setMsg(null);
    const data = await call(`/api/tasks/${taskId}/submit`, "POST", {
      title: title.trim() || undefined,
      content,
    });
    setBusy(false);
    if (!data.ok) {
      setMsg(data.error ?? "提交失败");
      toast.error(data.error ?? "提交失败");
      return;
    }
    setContent("");
    setMsg("已提交，等待 Auditor 验收");
    toast.success("已提交，等待 Auditor 验收");
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-4">
      <div className="mb-1 text-label font-medium text-ink">提交我的答案</div>
      <div className="mb-3 text-label text-faint">
        用自己的话写答案或产物；Auditor 会按验收标准逐条检查。
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="标题（可选）"
        className="mb-2 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="写下你的答案、代码、笔记或复盘…"
        className="w-full resize-y rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={submit}
          disabled={busy || !content.trim()}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Upload className="size-3" />
          )}
          提交产物
        </Button>
        {msg ? <span className="text-label text-muted">{msg}</span> : null}
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
  const [studyMinutes, setStudyMinutes] = useState(0);
  const [recall, setRecall] = useState<number | null>(null);
  const [errorTags, setErrorTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit() {
    setBusy(true);
    const data = await call("/api/checkin", "POST", {
      energy,
      mood,
      note,
      studyMinutes,
      recallScore: recall === null ? null : recall / 100,
      errorTags: errorTags
        .split(/[，,]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      completed: tasks.map((t) => ({ taskId: t.id, done: Boolean(done[t.id]) })),
    });
    setBusy(false);
    if (!data.ok) {
      toast.error(data.error ?? "打卡保存失败");
      return;
    }
    setSaved(true);
    toast.success("今日 check-in 已封存");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div
            id="checkin-energy-label"
            className="mb-2 text-eyebrow uppercase tracking-[0.16em] text-faint"
          >
            energy
          </div>
          <div
            role="group"
            aria-labelledby="checkin-energy-label"
            className="flex gap-1"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={energy === n}
                aria-label={`Energy ${n}`}
                onClick={() => setEnergy(n)}
                className={cn(
                  "h-7 flex-1 rounded border text-label transition-colors",
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
          <div
            id="checkin-mood-label"
            className="mb-2 text-eyebrow uppercase tracking-[0.16em] text-faint"
          >
            mood
          </div>
          <div
            role="group"
            aria-labelledby="checkin-mood-label"
            className="flex gap-1"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={mood === n}
                aria-label={`Mood ${n}`}
                onClick={() => setMood(n)}
                className={cn(
                  "h-7 flex-1 rounded border text-label transition-colors",
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
        {/* Every open task, not the first three: a checkbox you cannot reach
            is a task you cannot report as done. */}
        {tasks.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-panel2/40 px-3 py-2 text-xs text-muted hover:border-line2"
          >
            <input
              type="checkbox"
              checked={Boolean(done[t.id])}
              onChange={(e) => setDone((d) => ({ ...d, [t.id]: e.target.checked }))}
              className="size-3.5 accent-accent"
            />
            <span className="truncate">{t.title}</span>
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-2 block text-eyebrow uppercase tracking-[0.16em] text-faint">
            学习分钟
          </span>
          <input
            type="number"
            min={0}
            max={1440}
            value={studyMinutes}
            onChange={(e) => setStudyMinutes(Number(e.target.value) || 0)}
            className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink outline-none focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-eyebrow uppercase tracking-[0.16em] text-faint">
            回忆正确率 %
          </span>
          <input
            type="number"
            min={0}
            max={100}
            value={recall ?? ""}
            onChange={(e) =>
              setRecall(e.target.value === "" ? null : Number(e.target.value))
            }
            placeholder="可留空"
            className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </label>
      </div>

      <input
        value={errorTags}
        onChange={(e) => setErrorTags(e.target.value)}
        placeholder="薄弱点标签，用逗号分隔，例如：rerank, precision"
        className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
      />

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="30 秒备注：今天哪里卡住了？"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink placeholder:text-faint focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || saved}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          {saved ? "已保存" : "完成 check-in"}
        </Button>
        <span className="text-label text-faint" aria-live="polite">
          会写入记忆，供明天使用
        </span>
      </div>
    </div>
  );
}
