"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { call } from "./shared";

export function ReflectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const data = await call("/api/reflect", "POST");
    setBusy(false);
    const text = data.ok
      ? String(
          data.message ??
            (data.insightId ? "已生成新洞察" : "没有新的可执行信号"),
        )
      : (data.error ?? "失败");
    setMsg(text);
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
        运行反思
      </Button>
      {msg ? <span className="text-mini text-muted">{msg}</span> : null}
    </div>
  );
}

export function BriefButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const data = await call("/api/brief", "POST");
    setBusy(false);
    if (!data.ok) {
      toast.error(data.error ?? "早报生成失败");
      return;
    }
    toast.success("早报已重新生成");
    router.refresh();
  }
  return (
    <Button size="sm" variant="ghost" onClick={run} disabled={busy}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
      重新生成
    </Button>
  );
}

export function VerifyAuditButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/audit/verify");
    const data = await res.json();
    setBusy(false);
    const text = data.ok
      ? `链完整 · ${data.checked} 条`
      : `首个不一致：${data.firstMismatch ?? "未知"}`;
    setMsg(text);
    if (data.ok) {
      toast.success(text);
    } else {
      toast.error(text);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={run} disabled={busy}>
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ShieldCheck className="size-3" />
        )}
        验证审计链
      </Button>
      {msg ? <span className="text-mini text-muted">{msg}</span> : null}
    </div>
  );
}
