"use client";

import { useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Gavel,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Badge, Button } from "@/components/ui";
import { API_ROUTES } from "@/contracts/routes";
import type { BadgeTone } from "@/contracts/labels";
import { browserApi } from "@/lib/api/browser";
import type { PolicyEffect } from "@/lib/domain/policy";

/**
 * 任务详情页的「运行前的策略预演」。
 *
 * 用户点「运行」之前最想知道的一件事是「会不会被拦、被谁拦、怎么才能过」。
 * 这个问题以前只能靠点下去试：被拒之后从一句英文 reason 里猜，或者干脆等到
 * 审批才发现在等自己。面板把同一次判定（服务端 explainRunPolicy → decideRun）
 * 提前摊开，并且刻意只在展开时才请求 —— 预演是用户主动问的问题，不是页面
 * 打开就该发生的写操作。
 *
 * 这里不重复实现任何判定：四种结论、命中规则、缺什么，全部来自服务端。
 * 组件只负责把它翻译成颜色和排版。
 */

type PolicyPreview = {
  effect: PolicyEffect;
  rule: string;
  reason: string;
  missing: string[];
};

type Loaded<T> = { pending: boolean; error: string | null; value: T | null };

const EMPTY: Loaded<never> = { pending: false, error: null, value: null };

/**
 * 徽章配色沿用 statusTone 的语义：teal = 已经可以过去；accent = 在等人
 * （与 awaiting_approval 同色）；danger = 会被拒；violet = 建议而非执行。
 * 不改 contracts/labels.ts 是因为那张表是状态的词汇表，effect 是另一个维度。
 */
const EFFECT_LABEL: Record<PolicyEffect, string> = {
  allow: "直接放行",
  suggest: "只给建议",
  require_approval: "需要你批准",
  deny: "会被拒绝",
};

const EFFECT_TONE: Record<PolicyEffect, BadgeTone> = {
  allow: "teal",
  suggest: "violet",
  require_approval: "accent",
  deny: "danger",
};

const EFFECTS = new Set<string>(["allow", "suggest", "require_approval", "deny"]);

/* -------------------------------------------------------------------------
 * 手写解析（与 verifiability-panel 同一套做法）
 *
 * 契约漂移时给一句中文原因，而不是渲染成 undefined。effect 必须落在四种之内：
 * 它决定徽章颜色，未知值会让整个面板看起来像"放行"。
 * ---------------------------------------------------------------------- */

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(what + " 不是对象");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(what + " 不是字符串");
  return value;
}

function parsePreview(value: unknown): PolicyPreview {
  const row = asRecord(value, "策略预演");
  const effect = asString(row.effect, "effect");
  if (!EFFECTS.has(effect)) {
    throw new Error("effect 无法识别：" + effect);
  }
  if (!Array.isArray(row.missing)) throw new Error("missing 不是数组");
  const missing = row.missing.map((entry, index) =>
    asString(entry, "missing[" + index + "]"),
  );
  return {
    effect: effect as PolicyEffect,
    rule: asString(row.rule, "rule"),
    reason: asString(row.reason, "reason"),
    missing,
  };
}

export function PolicyPreviewPanel({
  taskId,
  hasAssignee = true,
}: {
  taskId: string;
  /** 没有执行者就没有可预演的判定（服务端会 409），不如在这里先说清楚。 */
  hasAssignee?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Loaded<PolicyPreview>>(EMPTY);

  async function load() {
    setState({ pending: true, error: null, value: null });
    const result = await browserApi.query<PolicyPreview>(
      API_ROUTES.taskPolicyPreview(taskId),
      parsePreview,
    );
    if (!result.ok) {
      // 原样显示服务端的中文原因：404（不是你的任务）、409（没有执行者）比
      // 一句笼统的"加载失败"更能说明下一步该做什么。
      setState({ pending: false, error: result.error, value: null });
      return;
    }
    setState({ pending: false, error: null, value: result.data });
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    // 只有第一次展开才请求：预演是用户主动要看的东西，首屏自动打一次接口
    // 等于给每个打开任务页的动作都加一次查询，而多数人根本不看这一块。
    if (next && !state.value && !state.pending && !state.error) void load();
  }

  if (!hasAssignee) {
    return (
      <div className="rounded-lg border border-dashed border-line px-3.5 py-3 text-label leading-relaxed text-muted">
        这条任务还没有执行者，所以没有可预演的判定。先指派一个 Agent，
        再回来看它会走哪条策略。
      </div>
    );
  }

  const data = state.value;

  return (
    <div className="space-y-3">
      <p className="text-label leading-relaxed text-muted">
        点开可以提前看到<span className="text-ink">这一次运行会命中哪条策略</span>
        ——和真正点「运行」时用的是同一次判定（包括授权、审批、本周预算），
        预演本身不会启动任何执行。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="policy-preview-body"
        >
          <ChevronDown
            className={"size-3 transition-transform " + (open ? "rotate-180" : "")}
            aria-hidden="true"
          />
          {open ? "收起策略预演" : "运行前的策略预演"}
        </Button>
        {open && (data || state.error) ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={state.pending}
            aria-busy={state.pending}
          >
            {state.pending ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-3" aria-hidden="true" />
            )}
            重新预演
          </Button>
        ) : null}
      </div>

      <div id="policy-preview-body">
        {open && state.pending ? (
          <div className="flex items-center gap-2 text-label text-muted">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            正在按当前策略判定…
          </div>
        ) : null}

        {open && state.error ? (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-3 text-label leading-relaxed text-danger">
            预演失败：{state.error}
          </div>
        ) : null}

        {open && data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={EFFECT_TONE[data.effect]}>
                {EFFECT_LABEL[data.effect]}
              </Badge>
              <span className="mono text-label text-faint">{data.rule}</span>
            </div>

            <p className="text-label leading-relaxed text-ink-soft">
              {data.reason}
            </p>

            {data.missing.length > 0 ? (
              <div className="rounded-lg border border-accent/30 bg-accent/[0.06] px-3.5 py-3">
                <div className="flex items-center gap-1.5 text-label font-medium text-accent">
                  <Gavel className="size-3.5" aria-hidden="true" />
                  要变成「直接放行」还缺这些
                </div>
                <ul className="mt-2 space-y-1.5">
                  {data.missing.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-1.5 text-label leading-relaxed text-ink-soft"
                    >
                      <ArrowRight
                        className="mt-0.5 size-3 shrink-0 text-faint"
                        aria-hidden="true"
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-lg border border-teal/30 bg-teal/[0.06] px-3.5 py-3 text-label leading-relaxed text-teal">
                没有待补的条件，点「运行」就会按这条策略执行。
              </div>
            )}

            {data.effect === "deny" ? (
              <p className="flex items-start gap-1.5 text-label leading-relaxed text-muted">
                <CircleAlert
                  className="mt-0.5 size-3.5 shrink-0 text-danger"
                  aria-hidden="true"
                />
                这是硬拦截：批准也解不开，必须按上面的缺项先改配置。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
