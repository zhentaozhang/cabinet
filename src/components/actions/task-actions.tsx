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
import { ConfirmDialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { InsightDto } from "@/contracts";
import { API_ROUTES } from "@/contracts/routes";
import { cn } from "@/lib/format";
import { call } from "./shared";

export function TaskActions({
  taskId,
  status,
  actions,
}: {
  taskId: string;
  status: string;
  /** Computed by the server: the guard and the button must agree. */
  actions: {
    run: { allowed: boolean; reason: string };
    audit: { allowed: boolean; reason: string };
    promote: { allowed: boolean; reason: string };
    cancel: { allowed: boolean; reason: string };
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function cancel() {
    setBusy("cancel");
    setMsg(null);
    const data = await call(`/api/tasks/${taskId}/cancel`, "POST", {});
    setBusy(null);
    if (!data.ok) {
      /*
       * Keep the dialog open on failure. Closing it drops the only retry
       * button on the page and returns focus to the trigger, so the error
       * toast lands detached from the action that produced it. The account
       * delete dialog already stays open for the same reason.
       */
      setMsg(data.error ?? "取消失败");
      toast.error(data.error ?? "取消失败");
      return;
    }
    setConfirmCancel(false);
    setMsg("已取消：记录和已花掉的钱都保留");
    toast.success("已取消，记录保留");
    router.refresh();
  }

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
      // Three outcomes: a pass, a rejection, and "no verdict" (needs_review).
      // Reporting the last one as a rejection would tell the user the Auditor
      // decided something it explicitly did not decide.
      const verdict = data.verdict ?? data.decision;
      if (verdict === "needs_review") {
        const txt = "验收没有给出结论，等你判定";
        setMsg(txt);
        toast.info(txt);
      } else {
        const isAccepted = verdict === "accepted";
        const txt = `验收结果：${isAccepted ? "通过" : "驳回"}`;
        setMsg(txt);
        if (isAccepted) {
          toast.success(txt);
        } else {
          toast.error(txt);
        }
      }
    } else if (data.queued) {
      setMsg("已排队，后台 worker 会执行");
      toast.info("已排队，后台 worker 会执行");
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
  const runLabel = finished
    ? "已完成"
    : status === "needs_review"
      ? "待你判定"
      : status === "submitted" || status === "auditing"
        ? "待验收"
      : status === "suggested"
        ? "待采纳"
        : status === "awaiting_approval"
          ? "待审批"
          : status === "rejected"
            ? "重新执行"
            : "开始执行";

  async function markDone() {
    setBusy("done");
    setMsg(null);
    const data = await call(API_ROUTES.taskDone(taskId), "POST");
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
          采纳这条建议
        </Button>
      ) : (
      <Button
        size="sm"
        onClick={() => run(`/api/tasks/${taskId}/run`, "run")}
        disabled={busy !== null || !actions.run.allowed}
        title={actions.run.allowed ? undefined : actions.run.reason}
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
          标记任务完成
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="primary"
        onClick={() => run(`/api/tasks/${taskId}/audit`, "audit")}
        disabled={busy !== null || !actions.audit.allowed}
        title={actions.audit.allowed ? undefined : actions.audit.reason}
      >
        {busy === "audit" ? <Loader2 className="size-3 animate-spin" /> : <FileCheck2 className="size-3" />}
        提交给 Auditor 验收
      </Button>
      {/*
        Always mounted: a live region that only appears when it has text is
        not reliably announced, so the node stays in the DOM and its content
        changes instead.
      */}
      <span role="status" aria-live="polite" className="text-label text-muted">
        {msg}
      </span>
      {/*
        When the primary action cannot be used, say why in the page instead of
        leaving a dead button. `actions.run.reason` comes from the same function
        the server guards with.
      */}
      {actions.cancel.allowed ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirmCancel(true)}
          disabled={busy !== null}
          className="text-faint hover:text-danger"
        >
          <X className="size-3" />
          取消任务
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        title="取消这个任务？"
        description="取消只是停止后续动作：已经产出的产物、证据、审计记录和已花掉的钱都会保留，不会被删除。正在执行的任务也能取消：这一轮运行会被标记为失败，途中可能已发生的用量按未知记账。"
        confirmLabel="确认取消任务"
        busy={busy === "cancel"}
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(false)}
      />
      {!actions.run.allowed && status !== "accepted" && status !== "done" ? (
        <span className="text-label text-faint">{actions.run.reason}</span>
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
        批准这次执行
      </Button>
      <Button size="sm" onClick={() => decide("reject")} disabled={busy !== null}>
        <X className="size-3" /> 驳回这次执行
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

/**
 * 策略键的中文名与单位。
 *
 * 为什么不直接 import src/lib/policy/overrides.ts 的键表：那是服务端模块（依赖
 * zod 与领域错误），客户端组件不该把它整包拉进 bundle。这份表只负责"读起来像人话"，
 * 真正的白名单与范围校验仍在服务端；这里认不出的键会原样显示路径，不假装认识。
 */
const POLICY_KEY_LABELS: Record<
  string,
  { label: string; unit?: string; ratio?: boolean }
> = {
  "reflection.windowDays": { label: "反思窗口", unit: " 天" },
  "reflection.minRejectEvents": { label: "触发反思的最少驳回次数", unit: " 次" },
  "reflection.minTaskSample": { label: "触发反思的最少任务样本", unit: " 个" },
  "reflection.eveningHour": { label: "晚间时段起点", unit: " 点" },
  "reflection.eveningCompletionThreshold": {
    label: "晚间完成率阈值",
    ratio: true,
  },
  "reflection.lowEnergyThreshold": { label: "低精力判定分", unit: " 分" },
  "reflection.budgetPressureRatio": { label: "预算压力比", ratio: true },
  "reflection.confidence": { label: "反思洞察置信度", ratio: true },
  "audit.rejectStreakLimit": { label: "连续驳回上限", unit: " 次" },
  "audit.passRateWindow": { label: "通过率统计窗口", unit: " 条" },
  "learning.nextTask.minWords": { label: "下一任务最少字数", unit: " 字" },
  "learning.nextTask.retestAfterDays": { label: "复测间隔", unit: " 天" },
  "learning.nextTask.minRecallScore": { label: "召回分下限", ratio: true },
  "learning.nextTask.estimateMin": { label: "下一任务预估时长", unit: " 分钟" },
  "learning.nextTask.maxErrorTags": { label: "错误标签上限", unit: " 个" },
  "learning.targetCheckinsPerWeek": { label: "每周打卡目标", unit: " 次/周" },
};

function policyLabel(key: string): string {
  return POLICY_KEY_LABELS[key]?.label ?? key;
}

function policyValueText(key: string, value: unknown): string {
  if (typeof value === "number") {
    const meta = POLICY_KEY_LABELS[key];
    const base = `${value}${meta?.unit ?? ""}`;
    // 0–1 的比率类阈值同时给出百分比：单看 0.35 判断不出是放松还是收紧。
    return meta?.ratio ? `${base}（${Math.round(value * 100)}%）` : base;
  }
  if (typeof value === "boolean") return value ? "开" : "关";
  return typeof value === "string" ? value : String(value);
}

function changeLabel(
  change: InsightDto["proposedChange"],
  status?: string,
): string {
  if (change.type === "set_policy" && typeof change.key === "string") {
    const value = policyValueText(change.key, change.value);
    /*
     * 回滚只撤掉这条洞察写的那条覆盖，配置回到默认值。此时还写"调整策略"
     * 会让人以为改动仍在生效，所以按洞察状态换一句结论。
     */
    return status === "rolled_back"
      ? `已恢复默认：${policyLabel(change.key)}（曾被改为 ${value}）`
      : `调整策略：${policyLabel(change.key)} → ${value}`;
  }
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
  /**
   * 策略覆盖会改掉"下一次决策"的输入（阈值、窗口、粒度），和改一条文案的任务
   * 不是一回事，所以采纳前要多一步确认。
   */
  const isPolicyChange =
    insight.proposedChange.type === "set_policy" &&
    typeof insight.proposedChange.key === "string";
  const [confirmPolicy, setConfirmPolicy] = useState(false);

  async function act(action: "accept" | "reject" | "rollback") {
    setBusy(action);
    setOptimisticStatus(
      // 回滚后的服务端状态是 rolled_back，乐观值也照写：写成 proposed 会让卡片
      // 在刷新的那一两秒里既显示"调整策略"，又把采纳/驳回按钮重新摆出来。
      action === "accept"
        ? "applied"
        : action === "reject"
          ? "rejected"
          : "rolled_back",
    );
    const data = await call(`/api/insights/${insight.id}`, "PATCH", { action });
    setBusy(null);
    if (!data.ok) {
      setOptimisticStatus(null);
      setMsg(data.error ?? "操作失败");
      toast.error(data.error ?? "操作失败");
      return;
    }
    const label =
      action === "accept"
        ? isPolicyChange
          ? "已采纳，策略已生效"
          : "已采纳"
        : action === "reject"
          ? "已拒绝"
          : isPolicyChange
            ? "已回滚，配置已恢复默认"
            : "已回滚";
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
          <p className="mt-2 text-emphasis font-medium leading-relaxed text-ink">
            {insight.claim}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="mono text-section text-ink">{Math.round(insight.confidence * 100)}%</div>
          <div className="text-label text-faint">confidence</div>
        </div>
      </div>

      <p className="mt-2 text-label leading-relaxed text-muted">{insight.rationale}</p>

      <div className="mt-3 rounded-lg border border-line bg-panel/60 px-3 py-2">
        <div className="text-eyebrow uppercase tracking-[0.14em] text-faint">proposed change</div>
        <div className="mt-1 text-label text-accent">
          {changeLabel(insight.proposedChange, status)}
        </div>
        {isPolicyChange && typeof insight.proposedChange.reason === "string" && insight.proposedChange.reason ? (
          <p className="mt-1 text-label text-muted">
            理由：{insight.proposedChange.reason}
          </p>
        ) : null}
        {isPolicyChange && status === "proposed" ? (
          <p className="mt-1 text-label text-faint">
            采纳后这条覆盖会立刻影响后续任务的判定阈值；不想要了可以回滚，配置会回到默认值。
          </p>
        ) : null}
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
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                // 写策略是多步后果（影响后续所有决策），先讲清楚再执行。
                if (isPolicyChange) setConfirmPolicy(true);
                else void act("accept");
              }}
              disabled={busy !== null}
            >
              {busy === "accept" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              {isPolicyChange ? "采纳并写入策略" : "采纳这项变更"}
            </Button>
            <Button size="sm" onClick={() => act("reject")} disabled={busy !== null}>
              <X className="size-3" /> 驳回这项变更
            </Button>
          </>
        ) : null}
        {insight.status === "applied" ? (
          <Button size="sm" onClick={() => act("rollback")} disabled={busy !== null}>
            {busy === "rollback" ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
            回滚这项变更
          </Button>
        ) : null}
        {/*
          Always mounted: a live region that only appears when it has text is
          not reliably announced, so the node stays in the DOM and its content
          changes instead.
        */}
        <span role="status" aria-live="polite" className="text-label text-muted">
          {msg}
        </span>
      </div>

      <div className="mt-3">
        <Progress
          value={insight.confidence * 100}
          tone="accent"
          label="洞察置信度"
        />
      </div>

      <ConfirmDialog
        open={confirmPolicy}
        variant="primary"
        title="写入这条策略覆盖？"
        confirmLabel="采纳并生效"
        busy={busy !== null}
        description={
          <span>
            「{policyLabel(String(insight.proposedChange.key ?? ""))}」会从默认值改成{" "}
            <span className="mono text-ink">
              {policyValueText(
                String(insight.proposedChange.key ?? ""),
                insight.proposedChange.value,
              )}
            </span>
            。这不是一次性改动：之后每一次任务判定、反思与下一任务生成都会读到新值。
            它是可以回滚的，回滚后配置恢复默认。
          </span>
        }
        onConfirm={async () => {
          await act("accept");
          setConfirmPolicy(false);
        }}
        onCancel={() => setConfirmPolicy(false)}
      />
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
    const data = await call(API_ROUTES.taskSubmit(taskId), "POST", {
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
        aria-label="产物标题（可选）"
        placeholder="标题（可选）"
        className="mb-2 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-label text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="产物内容"
        rows={5}
        placeholder="写下你的答案、代码、笔记或复盘…"
        className="w-full resize-y rounded-md border border-line bg-panel2 px-3 py-2 text-label text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
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
        {/*
          Always mounted: a live region that only appears when it has text is
          not reliably announced, so the node stays in the DOM and its content
          changes instead.
        */}
        <span role="status" aria-live="polite" className="text-label text-muted">
          {msg}
        </span>
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
            className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-panel2/40 px-3 py-2 text-label text-muted hover:border-line2"
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
            className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-label text-ink outline-none focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
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
            className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-label text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </label>
      </div>

      <input
        value={errorTags}
        onChange={(e) => setErrorTags(e.target.value)}
        aria-label="薄弱点标签（逗号分隔）"
        placeholder="薄弱点标签，用逗号分隔，例如：rerank, precision"
        className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-label text-ink outline-none placeholder:text-faint focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
      />

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="今日备注"
        placeholder="30 秒备注：今天哪里卡住了？"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-label text-ink placeholder:text-faint focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
