"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

export function MemoryActions({ memoryId }: { memoryId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm("删除这条记忆？Agent 将不再使用它。")) return;
    setBusy(true);
    await fetch(`/api/memories/${memoryId}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[9px] text-faint transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-2.5 animate-spin" /> : <Trash2 className="size-2.5" />}
      删除
    </button>
  );
}
