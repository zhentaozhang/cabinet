"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  Loader2,
  Pause,
  Play,
  Sparkles,
  UserMinus,
} from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/format";
import { call } from "./shared";

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
      toast.error(data.error ?? "升级失败");
      return;
    }
    toast.success(`授权已调整为 L${next}`);
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
              "flex-1 rounded-md border px-2 py-2 text-label transition-colors",
              level === n
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-line bg-panel2 text-muted hover:border-line2",
            )}
          >
            {busy === n ? <Loader2 className="mx-auto size-3 animate-spin" /> : `L${n}`}
          </button>
        ))}
      </div>
      <div className="mt-2 text-label text-faint">
        升级需要：信任分 ≥70 · 成功任务 ≥3 · 有效审计样本 ≥5 · 非试用期。
      </div>
      {error ? <div className="mt-2 text-label text-danger">{error}</div> : null}
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
    let text: string;
    if (!data.ok) {
      text = data.error ?? "失败";
    } else if (data.practicePassed === true) {
      text = `练习通过 ${Number(data.passed ?? 0)}/${Number(data.required ?? 0)}，学徒进入“练习通过”；转正还需要单独的评估。`;
    } else if (data.promoted === true) {
      text = `考试通过 ${Number(data.passed ?? 0)}/${Number(data.required ?? 0)}，已转正。`;
    } else if (data.retired === true) {
      text = `考试未通过 ${Number(data.passed ?? 0)}/${Number(data.required ?? 0)}，已累计 2 次失败，学徒已退休。`;
    } else {
      text = `考试未通过 ${Number(data.passed ?? 0)}/${Number(data.required ?? 0)}，仍在观察期，可复习后重考。`;
    }
    setResult(text);
    if (data.ok && (data.practicePassed === true || data.promoted === true)) {
      toast.success(text);
    } else {
      toast.error(text);
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
        运行结业考试
      </Button>
      {result ? <span className="text-label text-muted">{result}</span> : null}
      <span className="text-label text-faint">
        考试产物为确定性模拟，由 Auditor 按常规审计流程验收。
      </span>
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
  const [confirmRetire, setConfirmRetire] = useState(false);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setMsg(null);
    const data = await call(`/api/agents/${agentId}`, "PATCH", body);
    setBusy(null);
    setMsg(data.ok ? "已保存" : (data.error ?? "保存失败"));
    if (!data.ok) {
      toast.error(data.error ?? "保存失败");
      return;
    }
    toast.success(
      label === "retire"
        ? "Agent 已退休"
        : label === "pause"
          ? "Agent 已暂停"
          : label === "resume"
            ? "Agent 已恢复"
            : "已保存",
    );
    if (label === "retire") setConfirmRetire(false);
    router.refresh();
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
          confirmRetire ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={() => patch({ status: "retired" }, "retire")}
                disabled={busy !== null}
              >
                <UserMinus className="size-3" /> 确认退休
              </Button>
              <Button
                size="sm"
                onClick={() => setConfirmRetire(false)}
                disabled={busy !== null}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setConfirmRetire(true)}
              disabled={busy !== null}
            >
              <UserMinus className="size-3" /> 退休
            </Button>
          )
        ) : null}
      </div>

      <div>
        <div className="mb-1.5 text-eyebrow uppercase tracking-[0.16em] text-faint">
          Charter
        </div>
        <textarea
          value={draftCharter}
          onChange={(event) => setDraftCharter(event.target.value)}
          rows={4}
          className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-label leading-relaxed text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
        <div className="mb-1.5 text-eyebrow uppercase tracking-[0.16em] text-faint">
          Weekly budget (¥)
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            value={budgetYuan}
            onChange={(event) => setBudgetYuan(event.target.value)}
            className="h-8 w-24 rounded-md border border-line bg-panel2 px-2 text-label text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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

      {msg ? <div className="text-label text-muted">{msg}</div> : null}
    </div>
  );
}

type ObservationCandidate = {
  runId: string;
  taskId: string;
  taskTitle: string;
  artifactId: string | null;
  endedAt: string | null;
};

export function ObservationRecorder({
  candidates,
  observed,
  required,
}: {
  candidates: ObservationCandidate[];
  observed: number;
  required: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function record(runId: string) {
    setBusy(runId);
    const data = await call("/api/apprentice/observations", "POST", { runId });
    setBusy(null);
    if (!data.ok) {
      toast.error(data.error ?? "记录失败");
      return;
    }
    toast.success(
      data.duplicate === true
        ? "这条运行已经记录过，不会重复计数。"
        : `已记录观摩（${Number(data.observed ?? observed)}/${required}）`,
    );
    router.refresh();
  }

  if (candidates.length === 0) {
    return (
      <div className="rounded-md border border-line bg-panel2 px-3 py-2 text-label leading-relaxed text-faint">
        暂无可记录的 mentor 运行。需要 mentor 完成一次真实模型执行，且任务已经验收通过。
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-label text-muted">可记录的 mentor 运行</div>
      {candidates.map((candidate) => (
        <div
          key={candidate.runId}
          className="flex items-center justify-between gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <div className="truncate text-label text-fg">{candidate.taskTitle}</div>
            <div className="mono truncate text-label text-faint">
              {candidate.runId}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => record(candidate.runId)}
            disabled={busy !== null}
          >
            {busy === candidate.runId ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Brain className="size-3" />
            )}
            记录为观摩
          </Button>
        </div>
      ))}
    </div>
  );
}
