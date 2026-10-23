"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldOff } from "lucide-react";

import { API_ROUTES } from "@/contracts";
import { browserApi } from "@/lib/api/browser";
import { toast } from "@/components/ui/toast";

/**
 * Revoking a standing policy is a destructive, immediate change: the very next
 * run stops being pre-approved. So it is two-step and reports the outcome,
 * rather than being a single quiet icon.
 */
export function RevokeGrantButton({
  grantId,
  label,
}: {
  grantId: string;
  label: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    const result = await browserApi.mutate(API_ROUTES.grant(grantId), {
      method: "DELETE",
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setConfirming(false);
    toast.success("已撤销，这类动作会重新逐次询问你");
    router.refresh();
  }

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={revoke}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-danger/40 px-1.5 py-0.5 text-label text-danger disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-2.5 animate-spin" /> : null}
          确认撤销
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded border border-line px-1.5 py-0.5 text-label text-faint hover:text-muted disabled:opacity-50"
        >
          取消
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label={`撤销「${label}」`}
      className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-label text-faint transition-colors hover:border-danger/40 hover:text-danger"
    >
      <ShieldOff className="size-2.5" />
      撤销
    </button>
  );
}
