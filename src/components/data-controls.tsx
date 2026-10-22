"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui";

export function DataControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function exportData() {
    setBusy("export");
    setMsg(null);
    const response = await fetch("/api/export");
    const data = await response.json();
    setBusy(null);
    if (!response.ok || !data.ok) {
      setMsg(data.error ?? "导出失败");
      return;
    }
    const blob = new Blob([JSON.stringify(data.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cabinet-export.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setMsg("已导出");
  }

  async function deleteData() {
    if (
      !window.confirm(
        "删除账号会移除你的 Agent、任务、记忆与审计记录，且不可恢复。确认？",
      )
    ) {
      return;
    }
    setBusy("delete");
    setMsg(null);
    const response = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    const data = await response.json();
    setBusy(null);
    if (!response.ok || !data.ok) {
      setMsg(data.error ?? "删除失败");
      return;
    }
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={exportData} disabled={busy !== null}>
          {busy === "export" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Download className="size-3" />
          )}
          导出数据
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={deleteData}
          disabled={busy !== null}
        >
          {busy === "delete" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Trash2 className="size-3" />
          )}
          删除账号
        </Button>
      </div>
      <p className="text-[10px] leading-relaxed text-faint">
        导出包含 Agent、目标、任务、记忆、复盘和审计事件；不包含密码或会话。
      </p>
      {msg ? <div className="text-[10px] text-muted">{msg}</div> : null}
    </div>
  );
}
