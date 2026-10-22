"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { browserApi } from "@/lib/api/browser";

export function MemoryActions({ memoryId }: { memoryId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setMsg(null);
    const url = `/api/memories/${memoryId}`;
    const result = await browserApi.mutate(url, { method: "DELETE" });
    setBusy(false);
    if (!result.ok) {
      setMsg(result.error);
      return;
    }
    setConfirming(false);
    router.refresh();
  }

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <button
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-danger/40 px-1.5 py-0.5 text-label text-danger disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-2.5 animate-spin" /> : null}
          确认删除
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded border border-line px-1.5 py-0.5 text-label text-faint hover:text-muted disabled:opacity-50"
        >
          取消
        </button>
        {msg ? <span className="text-label text-danger">{msg}</span> : null}
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-label text-faint transition-colors hover:border-danger/40 hover:text-danger"
    >
      <Trash2 className="size-2.5" />
      删除
    </button>
  );
}
