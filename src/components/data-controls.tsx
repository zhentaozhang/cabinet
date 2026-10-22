"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";

export function DataControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function exportData() {
    setBusy("export");
    const response = await fetch("/api/export");
    const data = await response.json();
    setBusy(null);
    if (!response.ok || !data.ok) {
      toast.error(data.error ?? "导出失败");
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
    toast.success("数据导出成功");
  }

  async function deleteData() {
    setBusy("delete");
    const response = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    const data = await response.json();
    setBusy(null);
    if (!response.ok || !data.ok) {
      toast.error(data.error ?? "删除失败");
      return;
    }
    toast.success("账号已注销");
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
        {confirmDelete ? (
          <>
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
              确认彻底删除账号
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={busy !== null}
            >
              取消
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            disabled={busy !== null}
          >
            <Trash2 className="size-3" />
            删除账号
          </Button>
        )}
      </div>
      <p className="text-micro leading-relaxed text-faint">
        导出包含 Agent、目标、任务、记忆、复盘和审计事件；不包含密码或会话。
      </p>
    </div>
  );
}
