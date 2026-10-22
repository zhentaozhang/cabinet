"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { call } from "./shared";

export function NextLearningTaskButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    const data = await call("/api/learning/next-task", "POST");
    setBusy(false);
    if (!data.ok) {
      setMsg(data.error ?? "生成失败");
      toast.error(data.error ?? "生成失败");
      return;
    }
    setMsg("Coach 已安排好下一步");
    toast.success("Coach 已安排好下一步");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" onClick={run} disabled={busy}>
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Sparkles className="size-3" />
        )}
        让 Coach 安排下一步
      </Button>
      {msg ? <span className="text-mini text-muted">{msg}</span> : null}
    </div>
  );
}
