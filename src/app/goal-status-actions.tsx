"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Check,
  Loader2,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui";
import { goalActionLabel } from "@/contracts/labels";
import { API_ROUTES } from "@/contracts/routes";
import type { GoalTransitionAction } from "@/contracts/goals";
import { allowedGoalActions } from "@/contracts/goals";
import { call } from "@/components/actions/shared";

/**
 * 目标行的生命周期按钮：暂停 / 恢复 / 标记完成 / 归档 / 重新打开。
 *
 * 可用动作由服务端同一张状态表（src/contracts/goals.ts，服务端经
 * src/lib/domain/state.ts 复用）算出来，而不是这里再写一遍 if：按钮和校验
 * 分头维护时，"界面上能点、后端一定拒"这种漂移只会在用户点下去之后才暴露。
 * 表本身放在契约模块里，客户端引它才不会把 errors.ts 的日志上下文
 * （node:async_hooks）带进浏览器包。
 */
const ACTION_ICONS = {
  pause: Pause,
  resume: Play,
  complete: Check,
  archive: Archive,
  reopen: RotateCcw,
} as const;

export function GoalStatusActions({
  goalId,
  status,
  title,
}: {
  goalId: string;
  status: string;
  /** 用于 aria-label：一页里有多个目标，光读"归档"分不出是哪一个。 */
  title: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<GoalTransitionAction | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(
    null,
  );

  const actions = allowedGoalActions(status);

  async function run(action: GoalTransitionAction) {
    setBusy(action);
    setMsg(null);
    const data = await call(API_ROUTES.goalTransition(goalId), "POST", {
      action,
    });
    setBusy(null);

    if (!data.ok) {
      /*
       * 409 是"别人刚改过这个目标"，不是用户点错了：把服务端原话留在行内，
       * 再刷新一次让按钮与新状态对齐，避免他对着过期状态反复点。
       */
      if (data.code === "conflict") {
        setMsg({
          // 服务端 409 的原文是英文（Goal state changed; retry.），中文说明在前、
          // 原文留在括号里：既不把报错吞成四个字，也不让用户只看到一句英文。
          text: `状态已被其他操作改变，已刷新（服务端：${data.error ?? "conflict"}）`,
          tone: "error",
        });
        router.refresh();
        return;
      }
      setMsg({ text: data.error ?? "操作失败", tone: "error" });
      return;
    }

    setMsg({ text: `已${goalActionLabel(action)}`, tone: "ok" });
    router.refresh();
  }

  if (actions.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {actions.map((action) => {
        const Icon = ACTION_ICONS[action];
        return (
          <Button
            key={action}
            size="sm"
            variant="ghost"
            onClick={() => void run(action)}
            disabled={busy !== null}
            aria-label={`${goalActionLabel(action)}目标：${title}`}
          >
            {busy === action ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Icon className="size-3" />
            )}
            {goalActionLabel(action)}
          </Button>
        );
      })}
      {/* 常驻的 live region：只在有文字时才挂载的节点读屏软件不一定播报。 */}
      <span
        role="status"
        aria-live="polite"
        className={`text-label ${msg?.tone === "error" ? "text-danger" : "text-muted"}`}
      >
        {msg?.text ?? ""}
      </span>
    </div>
  );
}
