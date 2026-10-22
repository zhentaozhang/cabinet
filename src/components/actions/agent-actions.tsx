"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Sparkles, UserMinus } from "lucide-react";
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
              "flex-1 rounded-md border px-2 py-2 text-micro transition-colors",
              level === n
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-line bg-panel2 text-muted hover:border-line2",
            )}
          >
            {busy === n ? <Loader2 className="mx-auto size-3 animate-spin" /> : `L${n}`}
          </button>
        ))}
      </div>
      <div className="mt-2 text-mini text-faint">
        升级需要：信任分 ≥70 · 成功任务 ≥3 · 非试用期。
      </div>
      {error ? <div className="mt-2 text-micro text-danger">{error}</div> : null}
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
    const text = data.ok
      ? `考试通过 ${data.passed}/${data.required}，已转正。`
      : (data.error ?? "失败");
    setResult(text);
    if (data.ok) {
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
      {result ? <span className="text-micro text-muted">{result}</span> : null}
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
        <div className="mb-1.5 text-mini uppercase tracking-[0.16em] text-faint">
          Charter
        </div>
        <textarea
          value={draftCharter}
          onChange={(event) => setDraftCharter(event.target.value)}
          rows={4}
          className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-micro leading-relaxed text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
        <div className="mb-1.5 text-mini uppercase tracking-[0.16em] text-faint">
          Weekly budget (¥)
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            value={budgetYuan}
            onChange={(event) => setBudgetYuan(event.target.value)}
            className="h-8 w-24 rounded-md border border-line bg-panel2 px-2 text-micro text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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

      {msg ? <div className="text-mini text-muted">{msg}</div> : null}
    </div>
  );
}
