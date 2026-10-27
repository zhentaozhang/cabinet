"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleAlert, Loader2, X } from "lucide-react";

import { call } from "@/components/actions/shared";
import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { API_ROUTES } from "@/contracts/routes";

/** 与接口/命令同一条约束：少于 5 个字不叫理由。 */
const REASON_MIN = 5;
const REASON_MAX = 500;

/**
 * 「待你判定」卡片：Auditor 说"没有结论"时，人在这里拍板。
 *
 * 做成客户端组件只为一件事：两个按钮共用同一段理由，提交期间要禁用，
 * 失败要留在原地让用户改。表单提交 + 服务端渲染做不到"点驳回时按钮禁用"，
 * 这就是它必须带状态的原因。
 *
 * 判定本身不在浏览器里发生：POST /api/tasks/[id]/override 落库并写审计，
 * 成功后 router.refresh() 让横幅、清单、审计区一起刷新——页面上的状态永远
 * 来自服务端，不在这里自说自话。
 */
export function TaskDecisionCard({
  taskId,
  items,
}: {
  taskId: string;
  /** required 且 undetermined 的条目，来自 pendingDecisionItems。 */
  items: { statement: string; reason: string }[];
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"accepted" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reasonId = `decision-reason-${taskId}`;

  async function decide(decision: "accepted" | "rejected") {
    const note = reason.trim();
    if (note.length < REASON_MIN) {
      setError(`判定理由至少 ${REASON_MIN} 个字：请说明你依据什么下这个结论。`);
      return;
    }

    setBusy(decision);
    setError(null);
    const data = await call(API_ROUTES.taskOverride(taskId), "POST", {
      decision,
      reason: note,
    });
    setBusy(null);

    if (!data.ok) {
      /*
       * 冲突也要说人话。另一种常见情况是别人（或另一个标签页）先判过了，
       * 服务端回 409；这时按钮点了没反应最糟——用户会以为是自己没点中。
       */
      setError(data.error ?? "判定失败，请重试。");
      return;
    }

    setReason("");
    router.refresh();
  }

  return (
    <Card variant="decision">
      <CardHeader
        eyebrow="Human Verdict"
        title="待你判定"
        right={
          <Badge tone="accent">
            <CircleAlert className="size-3" /> 审计没有给出结论
          </Badge>
        }
      />
      <div className="space-y-3 px-5 py-4">
        <p className="text-label leading-relaxed text-ink-soft">
          清单里有必须判定、却没有判定人的条目。请写下理由再选择结论：判定会记进审计（含你判的是哪一份产物），
          但不会改变执行者的信任分——人的覆盖不是它的成绩。
        </p>

        {items.length > 0 ? (
          <ul className="space-y-1.5 rounded-lg border border-accent/25 bg-accent/[0.04] px-3 py-2.5">
            {items.map((item, index) => (
              <li key={`${item.statement}-${index}`} className="text-label leading-relaxed">
                <span className="font-medium text-ink">{item.statement}</span>
                <span className="ml-1.5 text-muted">— {item.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-accent/25 bg-accent/[0.04] px-3 py-2.5 text-label text-muted">
            清单里没有未判定项，但审计没有给出结论。
          </p>
        )}

        <div>
          <label
            htmlFor={reasonId}
            className="mb-1 block text-eyebrow font-medium uppercase tracking-wider text-faint"
          >
            判定理由（必填）
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              // 用户开始改就撤掉上一次的错误：留在那里的红字会指向已经改过的输入。
              if (error) setError(null);
            }}
            rows={3}
            maxLength={REASON_MAX}
            disabled={busy !== null}
            placeholder="例如：产物里的三条要点都能在会议记录里找到出处。"
            aria-describedby={error ? `${reasonId}-error` : undefined}
            className="w-full resize-y rounded-lg border border-line bg-panel2/60 px-3 py-2 text-label leading-relaxed text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
          <div className="mt-1 flex items-center justify-between text-eyebrow text-faint">
            <span>至少 {REASON_MIN} 个字</span>
            <span className="mono">
              {reason.trim().length}/{REASON_MAX}
            </span>
          </div>
        </div>

        {error ? (
          <p id={`${reasonId}-error`} role="alert" className="text-label text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => decide("accepted")}
            disabled={busy !== null}
          >
            {busy === "accepted" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            判定通过
          </Button>
          <Button
            variant="danger"
            onClick={() => decide("rejected")}
            disabled={busy !== null}
          >
            {busy === "rejected" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <X className="size-4" />
            )}
            判定驳回
          </Button>
          <span aria-live="polite" className="sr-only">
            {busy ? "正在提交判定" : ""}
          </span>
        </div>
      </div>
    </Card>
  );
}
