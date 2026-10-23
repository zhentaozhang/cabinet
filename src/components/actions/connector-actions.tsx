"use client";

import { useState } from "react";
import { Loader2, PlugZap } from "lucide-react";

import { API_ROUTES } from "@/contracts/routes";
import { type ConnectorTestDto } from "@/contracts";
import { browserApi } from "@/lib/api/browser";
import { parseConnectorTest } from "@/lib/api/parsers";
import { Badge, Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";

/** Providers are configuration ids; the page speaks product names. */
const PROVIDER_LABEL: Record<string, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
};

/** What a code means in words; the provider message carries the detail. */
const FAILURE_LABEL: Record<Exclude<ConnectorTestDto["status"], "ok">, string> = {
  not_configured: "未配置检索密钥",
  unauthorized: "密钥被拒绝",
  rate_limited: "被提供方限流",
  timeout: "请求超时",
  invalid_response: "返回内容无法解析",
  network_error: "网络不可达",
};

/**
 * Runs one real search. The expensive part is intentional: a "connected" badge
 * that was never exercised would be a lie.
 *
 * The outcome lives here and nowhere else — the page holds no probe state, so a
 * failure from five minutes ago can never be shown as the current status. Idle
 * therefore says "空闲", not "正常".
 */
export function ConnectorTestButton({ disabled = false }: { disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectorTestDto | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);

    // `browserApi.mutate` mints one idempotency key per intent, so a retried
    // transport failure is deduplicated while a deliberate second click is a
    // genuinely new probe.
    const response = await browserApi.mutate(API_ROUTES.connectorTest, {
      method: "POST",
      body: {},
      parse: parseConnectorTest,
    });
    setBusy(false);

    if (!response.ok) {
      toast.error(response.error);
      return;
    }

    setResult(response.data);
    if (response.data.status === "ok") {
      toast.success(
        `检索可用 · ${providerLabel(response.data.provider)} · ${response.data.hits} 条 · ${response.data.latencyMs}ms`,
      );
      return;
    }
    toast.error(response.data.message ?? FAILURE_LABEL[response.data.status]);
  }

  /** 空闲 / 测试中 / 成功（provider · ms · 命中数）/ 失败（原因） */
  const tone = busy
    ? "blue"
    : !result
      ? "neutral"
      : result.status === "ok"
        ? "teal"
        : "danger";

  const label = busy
    ? "测试中…"
    : !result
      ? "空闲"
      : result.status === "ok"
        ? `成功（${providerLabel(result.provider)} · ${result.latencyMs} ms · 命中 ${result.hits} 条）`
        : `失败（${FAILURE_LABEL[result.status]}）`;

  const detail =
    result && result.status !== "ok"
      ? result.message
      : result?.status === "ok" && result.sample
        ? `第一条：${result.sample.title}`
        : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={run}
          disabled={busy || disabled}
          variant="outline"
          size="sm"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <PlugZap className="size-3.5" aria-hidden />
          )}
          测试连通
        </Button>
        <div aria-live="polite">
          <Badge tone={tone}>{label}</Badge>
        </div>
      </div>
      {detail ? (
        <p className="mt-2 text-label leading-relaxed text-faint">{detail}</p>
      ) : null}
    </div>
  );
}

function providerLabel(provider: string | null): string {
  if (!provider) return "未知提供方";
  return PROVIDER_LABEL[provider] ?? provider;
}
