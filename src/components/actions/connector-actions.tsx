"use client";

import { useState } from "react";
import { PlugZap } from "lucide-react";

import {
  API_ROUTES,
  connectorTestSchema,
  type ConnectorTestDto,
} from "@/contracts";
import { browserApi } from "@/lib/api/browser";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";

const STATUS_COPY: Record<ConnectorTestDto["status"], string> = {
  ok: "连通正常",
  not_configured: "未配置密钥",
  unauthorized: "密钥被拒绝",
  rate_limited: "被限流",
  timeout: "超时",
  invalid_response: "响应无法解析",
  network_error: "网络错误",
};

/**
 * Runs one real search. The expensive part is intentional: a "connected"
 * badge that was never exercised would be a lie.
 */
export function ConnectorTestButton({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectorTestDto | null>(null);

  async function run() {
    setBusy(true);
    const response = await browserApi.mutate(API_ROUTES.connectorTest, {
      method: "POST",
      body: {},
      schema: connectorTestSchema,
    });
    setBusy(false);

    if (!response.ok) {
      toast.error(response.error);
      return;
    }
    setResult(response.data);
    if (response.data.status === "ok") {
      toast.success(`检索可用 · ${response.data.hits} 条结果 · ${response.data.latencyMs}ms`);
    } else {
      toast.error(STATUS_COPY[response.data.status]);
    }
  }

  return (
    <div>
      <Button onClick={run} disabled={busy || disabled} variant="outline" size="sm">
        <PlugZap className="size-3.5" aria-hidden />
        {busy ? "正在请求…" : "测试连通"}
      </Button>
      <div aria-live="polite" className="mt-2">
        {result ? (
          result.status === "ok" ? (
            <p className="text-label text-muted">
              搜到 {result.hits} 条，第一条：
              <a
                href={result.sample?.url ?? "#"}
                className="text-teal underline decoration-teal/40 underline-offset-2"
                rel="noreferrer noopener"
                target="_blank"
              >
                {result.sample?.title ?? "（无标题）"}
              </a>
            </p>
          ) : (
            <p className="text-label text-danger">
              {STATUS_COPY[result.status]}
              {result.message ? ` · ${result.message}` : ""}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
