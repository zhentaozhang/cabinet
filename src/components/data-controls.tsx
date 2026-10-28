"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

export function DataControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const value = await response.json();
      return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  async function exportData() {
    setBusy("export");
    try {
      const response = await fetch("/api/export");
      if (!response.ok) {
        // Errors are still JSON; a successful export is NDJSON.
        const data = await readJson(response);
        toast.error(String(data.error ?? "导出失败"));
        return;
      }
      const text = await response.text();
      if (!text.includes('"kind":"end"')) {
        toast.error("导出没有正常结束，文件可能不完整，请重试。");
        return;
      }
      const blob = new Blob([text], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cabinet-export.ndjson";
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("数据导出成功");
    } catch {
      toast.error("网络异常，导出失败，请重试。");
    } finally {
      setBusy(null);
    }
  }

  async function deleteData() {
    setBusy("delete");
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      const data = await readJson(response);
      if (!response.ok || data.ok !== true) {
        toast.error(String(data.error ?? "删除失败"));
        return;
      }
      toast.success("账号已注销");
      await authClient.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      toast.error("网络异常，删除失败，请重试。");
    } finally {
      setBusy(null);
    }
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
          onClick={() => setConfirmDelete(true)}
          disabled={busy !== null}
        >
          <Trash2 className="size-3" />
          删除账号
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="彻底删除这个账号？"
        description="账号、Agent、任务、记忆和审计链会一起删除，且无法恢复。建议先导出数据。"
        confirmLabel="确认彻底删除"
        busy={busy === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={deleteData}
      />
      <p className="text-label leading-relaxed text-faint">
        导出包含 Agent、目标、任务、记忆、复盘、审计事件、学习历史、外部工具配置和操作流水；
        不包含密码、登录会话、幂等键和限流窗口。
      </p>
    </div>
  );
}
