"use client";

import { useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui";
import { API_ROUTES } from "@/contracts/routes";
import { browserApi } from "@/lib/api/browser";
import { parseAuditVerification } from "@/lib/api/parsers";

/**
 * 「校验审计链」按钮 + 结果面板。
 *
 * 上一版（src/components/actions/utility-buttons.tsx 的 VerifyAuditButton）只把一行
 * 文字塞进页头："链完整 · N 条"。可这条链存在的意义就是回答三个问题——
 * 校验了多少条、链是否连续、第一条对不上的是哪一条——一行字装不下，而且它
 * 失败时只显示"校验失败"式的占位，把服务端写的原因丢掉了。
 *
 * 所以这里单独成组件：三条结论各自占一行，失败时原样打印服务端/网络返回的报错。
 * 不用 toast：校验结论需要留在页面上被对照，不是一闪而过的提示。
 */

type Verification = { verified: boolean; checked: number; firstMismatch: string | null };

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; value: Verification };

export function AuditChainCheck({ total }: { total: number }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    const result = await browserApi.query(API_ROUTES.verifyAudit, parseAuditVerification);
    if (!result.ok) {
      // 原样显示：客户端只会把纯英文占位（"Internal error"）换成中文短句，
      // 服务端有意写下的原因会原封不动地到达这里。
      setState({ kind: "error", message: result.error });
      return;
    }
    setState({ kind: "done", value: result.data });
  }

  const busy = state.kind === "loading";

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      <Button
        variant="outline"
        size="sm"
        onClick={run}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="size-3" aria-hidden="true" />
        )}
        校验审计链
      </Button>

      {state.kind === "done" && state.value.verified ? (
        <div
          role="status"
          className="w-full rounded-lg border border-teal/30 bg-teal/[0.06] px-3 py-2.5 text-label leading-relaxed sm:max-w-md"
        >
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-teal">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            哈希链连续，{state.value.checked} 条记录全部重算通过
          </div>
          <p className="mt-1 text-muted">
            每一条的 hash 都由它自己的字段重算得出，并且与它记录的上一条 hash 接得上。
            {state.value.checked === 0
              ? " （0 条 —— 这个账号还没有审计事件，所以现在没有可校验的链；等第一次验收或审批之后再来点一次。）"
              : null}
          </p>
          <p className="mt-1 text-faint">
            结论只覆盖点击这一刻库里的记录；之后新写入的事件需要再校验一次。
          </p>
        </div>
      ) : null}

      {state.kind === "done" && !state.value.verified ? (
        <div
          role="alert"
          className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-label leading-relaxed sm:max-w-md"
        >
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-danger">
            <ShieldAlert className="size-3.5" aria-hidden="true" />
            链在这里断了：前 {state.value.checked} 条通过，第 {state.value.checked + 1} 条对不上
          </div>
          <p className="mt-1 text-muted">
            出问题的事件：
            <span className="mono ml-1 break-all text-danger">
              {state.value.firstMismatch ?? "服务端没有给出事件 id"}
            </span>
          </p>
          <p className="mt-1 text-muted">
            这一条要么自己的字段和它写下的 hash 对不上（被改过），
            要么它的 prevHash 接不上前一条（被删过或插过）。两种情况都说明链在这里不完整，
            不能把它当作「没被改动过」。
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div
          role="alert"
          className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-label leading-relaxed sm:max-w-md"
        >
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-danger">
            <ShieldQuestion className="size-3.5" aria-hidden="true" />
            这次校验没跑完
          </div>
          {/* 原样打印，不吞成"校验失败"：读不出原因就没法判断是链路问题还是网络问题。 */}
          <p className="mt-1 break-words text-danger">{state.message}</p>
          <p className="mt-1 text-faint">
            上面这句是接口返回的原文。此时没有结论——不要把它当作「链是完整的」。
          </p>
        </div>
      ) : null}

      {state.kind === "idle" ? (
        <span className="text-label text-faint">
          当前列表里 {total} 条事件；校验会重算全部记录，不受上面的筛选影响。
        </span>
      ) : null}
    </div>
  );
}
