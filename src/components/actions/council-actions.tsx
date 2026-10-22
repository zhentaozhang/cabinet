"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { call } from "./shared";

export function CouncilActions({ councilId }: { councilId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject" | "conditions") {
    if (decision === "reject" && !note.trim()) {
      setMsg("否决必须填写理由（会写入审计）。");
      toast.error("否决必须填写理由");
      return;
    }
    setBusy(decision);
    setMsg(null);
    const data = await call(`/api/council/${councilId}`, "PATCH", {
      decision,
      note,
    });
    setBusy(null);
    if (!data.ok) {
      setMsg(data.error ?? "决定失败");
      toast.error(data.error ?? "决定失败");
      return;
    }
    setNote("");
    setMsg("决定已写入审计链");
    toast.success("决定已写入审计链");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="决定理由（会写入审计）"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => decide("approve")} disabled={busy !== null}>
          批准
        </Button>
        <Button size="sm" onClick={() => decide("conditions")} disabled={busy !== null}>
          有条件批准
        </Button>
        <Button size="sm" variant="danger" onClick={() => decide("reject")} disabled={busy !== null || !note.trim()}>
          否决
        </Button>
      </div>
      <div className="text-label text-faint">否决必须填写理由，理由会写入审计链。</div>
      {msg ? <div className="text-label text-muted">{msg}</div> : null}
    </div>
  );
}

export function NewCouncilForm() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [trigger, setTrigger] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    const data = await call("/api/councils", "POST", { topic, trigger });
    setBusy(false);
    if (!data.ok) {
      setMsg(data.error ?? "失败");
      toast.error(data.error ?? "发起失败");
      return;
    }
    setTopic("");
    setTrigger("");
    setMsg("已发起，正在按规则生成立场");
    toast.success("会议已发起，正在按规则生成立场");
    router.refresh();
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        value={topic}
        onChange={(event) => setTopic(event.target.value)}
            aria-label="议题"
        placeholder="议题"
        className="h-8 w-full rounded border border-line bg-panel2 px-2 text-label text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <input
        value={trigger}
        onChange={(event) => setTrigger(event.target.value)}
            aria-label="触发条件"
        placeholder="触发条件（如：单笔支出 > ¥200）"
        className="h-8 w-full rounded border border-line bg-panel2 px-2 text-label text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <Button
        size="sm"
        type="submit"
        disabled={busy || !topic.trim() || !trigger.trim()}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        发起会议
      </Button>
      {msg ? <div className="text-label text-muted">{msg}</div> : null}
    </form>
  );
}
