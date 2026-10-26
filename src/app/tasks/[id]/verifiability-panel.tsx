"use client";

import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileJson,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { browserApi } from "@/lib/api/browser";
import { dateTime } from "@/lib/format";
import { API_ROUTES } from "@/contracts/routes";
import type { AcceptanceContract } from "@/lib/domain/acceptance-export";
import type { RunManifest } from "@/lib/domain/manifest";

/**
 * 任务详情页的「可核验性」区块。
 *
 * 这里不是又一份页面内容，而是页面的「证据出口」：
 *  - run manifest 由一次 run 落库的步骤/产物/证据重算出哈希，别人拿着它就能核对
 *    「这次执行到底产出了什么」，不需要登录本系统；
 *  - 验收契约是同一条 checklist 的可导出表述，同一任务导两次字节一致，可以 diff。
 *
 * 两个接口都已存在（GET /api/tasks/[id]/manifest、GET /api/tasks/[id]/acceptance），
 * 此前页面上没有任何入口，属于「能力黑洞」：能力在，但用户够不到。
 */

// 路径统一从契约里取：同一条 URL 散落在两处，早晚有一天只改了一边。
const manifestPath = (taskId: string) => API_ROUTES.taskManifest(taskId);
const acceptancePath = (taskId: string) => API_ROUTES.taskAcceptance(taskId);

/* -------------------------------------------------------------------------
 * 手写解析
 *
 * manifest 路由直接返回本体（没有 { ok, data } 信封），所以必须用
 * request(..., { envelope: "flat" })。这里只校验面板真正会读的字段：契约漂移时
 * 给出一句中文原因，而不是渲染时炸成 undefined。
 * ---------------------------------------------------------------------- */

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(what + " 不是对象");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(what + " 不是数组");
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(what + " 不是字符串");
  return value;
}

const VERDICTS = new Set(["pass", "fail", "undetermined"]);

function parseManifest(value: unknown): RunManifest {
  const row = asRecord(value, "run manifest");
  asString(row.runId, "runId");
  asString(row.digest, "digest");
  asArray(row.steps, "steps");
  asArray(row.artifacts, "artifacts");
  asArray(row.acceptance, "acceptance").forEach((entry, index) => {
    const item = asRecord(entry, "第 " + (index + 1) + " 条验收");
    const verdict = asString(item.verdict, "第 " + (index + 1) + " 条验收的 verdict");
    if (!VERDICTS.has(verdict)) {
      throw new Error("第 " + (index + 1) + " 条验收的 verdict 无法识别：" + verdict);
    }
  });
  if (row.auditHead !== null && row.auditHead !== undefined) {
    asString(asRecord(row.auditHead, "auditHead").hash, "auditHead.hash");
  }
  // 校验过的字段之外原样交回去：manifest 是文件，不是本面板的私有视图。
  return row as unknown as RunManifest;
}

function parseAcceptance(value: unknown): {
  contract: AcceptanceContract;
  markdown: string;
} {
  const row = asRecord(value, "验收契约");
  const contract = asRecord(row.contract, "验收契约的 contract");
  asArray(contract.checks, "契约 checks");
  return {
    contract: contract as unknown as AcceptanceContract,
    markdown: asString(row.markdown, "契约 markdown"),
  };
}

/* -------------------------------------------------------------------------
 * 下载
 *
 * 与 src/components/data-controls.tsx 的导出是同一套做法：Blob + 一次性 a.click()。
 * 不发第二次请求——手里这份就是刚展示给用户的同一份 JSON。
 * ---------------------------------------------------------------------- */

function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // click 之后浏览器已经拿走了 blob，这里只回收内存。
  URL.revokeObjectURL(url);
}

function shortHash(value: string): string {
  return value.slice(0, 16);
}

function VerdictBadge({ verdict }: { verdict: string }) {
  if (verdict === "pass") {
    return (
      <Badge tone="teal">
        <CheckCircle2 className="size-3" /> 通过
      </Badge>
    );
  }
  if (verdict === "fail") {
    return (
      <Badge tone="danger">
        <XCircle className="size-3" /> 未通过
      </Badge>
    );
  }
  return (
    <Badge tone="accent">
      <CircleAlert className="size-3" /> 未判定
    </Badge>
  );
}

/** manifest 里的验收项是原始 jsonb，展示时只用确定存在的几个键。 */
function describeManifestItem(item: Record<string, unknown>): string {
  const type = typeof item.type === "string" ? item.type : "未知类型";
  const detail =
    typeof item.value === "string"
      ? item.value
      : typeof item.note === "string"
        ? item.note
        : typeof item.statement === "string"
          ? item.statement
          : null;
  return detail ? type + " · " + detail : type;
}

type Loaded<T> = { pending: boolean; error: string | null; value: T | null };

const EMPTY: Loaded<never> = { pending: false, error: null, value: null };

export function VerifiabilityPanel({
  taskId,
  timezone,
  hasRuns,
  hasChecklist,
}: {
  taskId: string;
  timezone?: string;
  /** 任务有没有运行记录。没有 run 就没有东西可重算哈希，不能说"生成了一份空的"。 */
  hasRuns: boolean;
  /** 任务有没有验收清单。没有清单时导出的契约只有一条"需人工判定"的说明。 */
  hasChecklist: boolean;
}) {
  const [manifest, setManifest] = useState<Loaded<RunManifest>>(EMPTY);
  const [contract, setContract] = useState<
    Loaded<{ contract: AcceptanceContract; markdown: string }>
  >(EMPTY);

  async function loadManifest() {
    setManifest({ pending: true, error: null, value: null });
    const result = await browserApi.request<RunManifest>(manifestPath(taskId), {
      // 这条路没有 { ok, data } 信封，直接是 manifest 本体。
      envelope: "flat",
      parse: parseManifest,
    });
    if (!result.ok) {
      // 原样显示：服务端写的中文原因（比如「该任务还没有可导出的运行记录」）比
      // 一句笼统的"加载失败"更有用。
      setManifest({ pending: false, error: result.error, value: null });
      return;
    }
    setManifest({ pending: false, error: null, value: result.data });
  }

  async function loadContract() {
    setContract({ pending: true, error: null, value: null });
    const result = await browserApi.request<{
      contract: AcceptanceContract;
      markdown: string;
    }>(acceptancePath(taskId), { parse: parseAcceptance });
    if (!result.ok) {
      setContract({ pending: false, error: result.error, value: null });
      return;
    }
    setContract({ pending: false, error: null, value: result.data });
  }

  const manifestData = manifest.value;
  const contractData = contract.value;
  const verdicts = manifestData
    ? {
        pass: manifestData.acceptance.filter((row) => row.verdict === "pass").length,
        fail: manifestData.acceptance.filter((row) => row.verdict === "fail").length,
        undetermined: manifestData.acceptance.filter(
          (row) => row.verdict === "undetermined",
        ).length,
      }
    : null;

  return (
    <div className="space-y-3">
      <p className="text-label leading-relaxed text-muted">
        下面两份东西是这一页的<span className="text-ink">证据出口</span>
        ：左边展示的是系统怎么说的，导出的文件是别人可以拿去独立核对的同一份事实。
        它们都不包含你的提示词原文——只包含哈希。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={loadManifest}
          disabled={manifest.pending || !hasRuns}
          aria-busy={manifest.pending}
        >
          {manifest.pending ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <FileJson className="size-3" aria-hidden="true" />
          )}
          查看 run manifest
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={loadContract}
          disabled={contract.pending}
          aria-busy={contract.pending}
        >
          {contract.pending ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="size-3" aria-hidden="true" />
          )}
          导出验收契约
        </Button>
      </div>

      {/* 没有 run：说清楚为什么这里是空的，而不是给一个点了会 404 的按钮 */}
      {!hasRuns ? (
        <div className="rounded-lg border border-dashed border-line px-3.5 py-3 text-label leading-relaxed text-muted">
          这个任务还没有运行记录，所以没有可导出的 run manifest。
          manifest 是从一次 run 落库的步骤、产物与证据重算出来的哈希清单；
          没有 run 就没有任何东西可算，也不会替你生成一份空白文件。
        </div>
      ) : null}

      {/* manifest 的错误态 */}
      {manifest.error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-3 text-label leading-relaxed text-danger">
          读取 manifest 失败：{manifest.error}
        </div>
      ) : null}

      {manifestData ? (
        <div className="rounded-lg border border-teal/30 bg-teal/[0.06] px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-label font-medium text-teal">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              manifest 已生成
            </span>
            <span className="mono text-label text-faint">
              {manifestData.runId}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() =>
                downloadText(
                  manifestData.runId + ".manifest.json",
                  JSON.stringify(manifestData, null, 2),
                  "application/json",
                )
              }
            >
              <Download className="size-3" aria-hidden="true" />
              下载 JSON
            </Button>
          </div>

          <p className="mt-2 text-label leading-relaxed text-muted">
            离线可校验：把这份 JSON 与本页可见内容对照 ——
            步骤、产物哈希、验收逐条判定和审计头都在文件里，
            对方不需要登录这套系统也能重算一遍。
          </p>

          <dl className="mt-3 space-y-1.5 text-label">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-faint">状态 / 生成时间</dt>
              <dd className="text-ink">
                {manifestData.status} · {dateTime(manifestData.createdAt, timezone)}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-faint">模型</dt>
              <dd className="text-ink">
                {manifestData.model.provider && manifestData.model.model
                  ? manifestData.model.provider + " / " + manifestData.model.model
                  : "未记录（这次不是模型产出，或当时没记下供应商）"}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-faint">步骤</dt>
              <dd className="text-ink">
                {manifestData.steps.length} 步
                {manifestData.merkleRoot ? (
                  <span className="ml-2 mono text-faint">
                    merkle {shortHash(manifestData.merkleRoot)}
                  </span>
                ) : (
                  <span className="ml-2 text-faint">· 没有步骤，所以没有 merkle 根</span>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-faint">审计头</dt>
              <dd className="text-ink">
                {manifestData.auditHead ? (
                  <>
                    <span className="mono">#{manifestData.auditHead.seq}</span>
                    <span className="ml-2 mono text-faint">
                      {shortHash(manifestData.auditHead.hash)}
                    </span>
                  </>
                ) : (
                  <span className="text-faint">
                    空 —— 这个账号当时还没有审计事件，文件里不伪造一个 seq 0
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {manifestData.artifacts.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 text-eyebrow uppercase tracking-wider text-faint">
                产物哈希（{manifestData.artifacts.length} 项）
              </div>
              <ul className="space-y-1">
                {manifestData.artifacts.map((artifact) => (
                  <li
                    key={artifact.id}
                    className="flex flex-wrap items-baseline gap-x-2 text-label"
                  >
                    <span className="mono text-ink-soft">{artifact.id}</span>
                    <span className="mono text-faint">{shortHash(artifact.sha256)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-3 text-label text-faint">
              这次 run 没有落库产物，所以没有可对照的产物哈希。
            </div>
          )}

          <div className="mt-3">
            <div className="mb-1 text-eyebrow uppercase tracking-wider text-faint">
              验收逐条判定
            </div>
            {manifestData.acceptance.length === 0 ? (
              <p className="text-label text-faint">
                这次 run 没有验收记录（auditor 还没跑，或任务没有 checklist），
                所以这里没有可以逐条对照的判定。
              </p>
            ) : (
              <>
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  {verdicts ? (
                    <>
                      <Badge tone="teal">通过 {verdicts.pass}</Badge>
                      <Badge tone="danger">未通过 {verdicts.fail}</Badge>
                      <Badge tone="accent">未判定 {verdicts.undetermined}</Badge>
                    </>
                  ) : null}
                  {manifestData.acceptanceRunId ? (
                    <span className="mono text-label text-faint">
                      run {manifestData.acceptanceRunId}
                    </span>
                  ) : null}
                </div>
                <ul className="space-y-1">
                  {manifestData.acceptance.map((row, index) => (
                    <li
                      key={index}
                      className="flex flex-wrap items-baseline gap-x-2 text-label"
                    >
                      <VerdictBadge verdict={row.verdict} />
                      <span className="min-w-0 break-words text-ink-soft">
                        {describeManifestItem(row.item)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="mt-3 border-t border-line/60 pt-2 text-label">
            <span className="text-faint">文件摘要 digest</span>
            <div className="mt-0.5 break-all mono text-label text-muted select-all">
              {manifestData.digest}
            </div>
            <p className="mt-1 leading-relaxed text-faint">
              对方重算这份文件的 digest 与 merkle 根，就能判断它有没有被改过；
              审计头是否接得上，还需要对方的链路数据才能核对。
            </p>
          </div>
        </div>
      ) : null}

      {/* 契约的错误态 */}
      {contract.error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-3 text-label leading-relaxed text-danger">
          导出验收契约失败：{contract.error}
        </div>
      ) : null}

      {contractData ? (
        <div className="rounded-lg border border-line bg-panel2/50 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              契约 {contractData.contract.checks.length} 条
            </Badge>
            <Badge tone="accent">
              需人工/模型判定{" "}
              {contractData.contract.checks.filter((check) => check.undetermined).length} 条
            </Badge>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  downloadText(
                    contractData.contract.taskId + ".acceptance.md",
                    contractData.markdown,
                    "text/markdown;charset=utf-8",
                  )
                }
              >
                <Download className="size-3" aria-hidden="true" />
                下载 Markdown
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  downloadText(
                    contractData.contract.taskId + ".acceptance.json",
                    JSON.stringify(contractData.contract, null, 2),
                    "application/json",
                  )
                }
              >
                <Download className="size-3" aria-hidden="true" />
                JSON
              </Button>
            </div>
          </div>

          <p className="mt-2 text-label leading-relaxed text-muted">
            同一任务导两次的字节是一样的（契约不带时间戳、不带随机 id），
            所以可以拿两次导出直接 diff，判断「要交付什么」有没有被悄悄改过。
          </p>

          {!hasChecklist ? (
            <p className="mt-2 rounded-md border border-dashed border-line px-2.5 py-2 text-label leading-relaxed text-muted">
              这个任务没有验收清单：导出的契约里只有一条「需人工判定」的说明 ——
              那是系统在如实说明自己没有逐条对照过，而不是一张真的核对表。
            </p>
          ) : null}

          <details className="mt-2">
            <summary className="cursor-pointer text-label text-faint hover:text-muted">
              逐条展开（{contractData.contract.checks.length} 条）
            </summary>
            <ul className="mt-1.5 space-y-1.5">
              {contractData.contract.checks.map((check) => (
                <li key={check.id} className="text-label leading-relaxed">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mono text-faint">{check.id}</span>
                    {check.required ? (
                      <span className="text-eyebrow font-semibold text-danger">*必选</span>
                    ) : null}
                    {check.undetermined ? (
                      <Badge tone="accent">需判定</Badge>
                    ) : (
                      <Badge tone="teal">规则可判</Badge>
                    )}
                  </div>
                  <div className="text-ink-soft">{check.statement}</div>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {!contractData && !contract.error && hasChecklist ? (
        <p className="text-label leading-relaxed text-faint">
          验收契约是这条清单的可导出版本：点上面的按钮会拿到
          「这一版要交付什么」的完整表述，含每一条是否可由规则自动判定。
        </p>
      ) : null}
    </div>
  );
}
