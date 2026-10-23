"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/format";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  /*
   * Disabling the focused button moves focus to `<body>`, which drops a screen
   * reader out of the dialog at exactly the moment it is announcing progress.
   * Park focus on the surface instead — it is `tabIndex={-1}`, so Tab still
   * walks into the controls from there.
   */
  useEffect(() => {
    if (!open || !busy) return;
    const active = document.activeElement;
    if (active instanceof Node && dialogRef.current?.contains(active)) return;
    dialogRef.current?.focus();
  }, [open, busy]);

  /*
   * Depends on `open` alone. `busy` flips as the confirm runs and again when it
   * settles, and re-running this effect on each flip would tear the modal down
   * mid-flight: the cleanup returns focus to the page behind the dialog, and
   * `previousFocus` gets re-captured as whatever is focused at that instant —
   * often a control inside the dialog, so closing it later would try to restore
   * focus to a node that no longer exists. The keyboard handler reads `busy`
   * through a ref instead.
   */
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;

    // aria-modal hides the background from screen readers, but the page behind
    // still scrolls on wheel/touch, which makes the dialog feel broken.
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const frame = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const nodes = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      );
      if (nodes.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      /*
       * Focus can end up outside the dialog — a click on the backdrop, a stray
       * programmatic focus, or the browser restoring focus after a re-render.
       * The wrap-around checks below only fire when focus sits exactly on the
       * first or last control, so an outside focus would tab through the page
       * behind the modal. Pull it back in first.
       */
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      body.style.overflow = previousOverflow;
      if (previousFocus.current instanceof HTMLElement) {
        previousFocus.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
        onClick={() => {
          if (!busy) onCancel();
        }}
      />

      {/* Modal Surface */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        aria-describedby="confirm-dialog-description"
        className={cn(
          "obsidian-card relative z-10 w-full max-w-md overflow-hidden rounded-xl border p-6 shadow-2xl",
          variant === "danger" ? "border-danger/40" : "border-line2",
        )}
      >
        <div className="flex items-start gap-3.5">
          {variant === "danger" ? (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-danger/40 bg-danger/10 text-danger">
              <AlertTriangle className="size-4" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <h3
              id="confirm-dialog-title"
              className="text-section font-semibold tracking-tight text-ink"
            >
              {title}
            </h3>
            <div
              id="confirm-dialog-description"
              className="mt-2 text-emphasis leading-relaxed text-muted"
            >
              {description}
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
