"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/format";

export type ToastType = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  type: ToastType;
  message: string;
};

type ToastListener = (toast: ToastItem) => void;
const listeners = new Set<ToastListener>();

/** Errors need longer than a successful "saved" confirmation. */
const TTL: Record<ToastType, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

function emit(type: ToastType, message: string) {
  const item: ToastItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    message,
  };
  listeners.forEach((listener) => listener(item));
}

export const toast = {
  success(message: string) {
    emit("success", message);
  },
  error(message: string) {
    emit("error", message);
  },
  info(message: string) {
    emit("info", message);
  },
};

type Live = { item: ToastItem; expiresAt: number };

export function ToastContainer() {
  const [toasts, setToasts] = useState<Live[]>([]);
  const heldIds = useRef(new Set<string>());

  useEffect(() => {
    const handleToast: ToastListener = (item) => {
      const now = Date.now();
      setToasts((prev) =>
        [...prev.slice(-3), { item, expiresAt: now + TTL[item.type] }].slice(-4),
      );
    };

    listeners.add(handleToast);
    return () => {
      listeners.delete(handleToast);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) =>
        prev.filter(
          (toastItem) =>
            heldIds.current.has(toastItem.item.id) ||
            toastItem.expiresAt > now,
        ),
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  function dismiss(id: string) {
    heldIds.current.delete(id);
    setToasts((prev) => prev.filter((toastItem) => toastItem.item.id !== id));
  }

  /** Hovering or focusing a toast pauses its timer, so it can be read. */
  function hold(id: string, holding: boolean) {
    if (holding) heldIds.current.add(id);
    else heldIds.current.delete(id);
  }

  const routine = toasts.filter((t) => t.item.type !== "error");
  const failures = toasts.filter((t) => t.item.type === "error");

  const render = (list: Live[]) =>
    list.map(({ item }) => (
      <div
        key={item.id}
        onMouseEnter={() => hold(item.id, true)}
        onMouseLeave={() => hold(item.id, false)}
        onFocus={() => hold(item.id, true)}
        onBlur={() => hold(item.id, false)}
        className={cn(
          "obsidian-card pointer-events-auto flex items-start gap-3 rounded-xl border p-3.5 shadow-2xl",
          item.type === "success" && "border-teal/40 bg-panel/95",
          item.type === "error" && "border-danger/40 bg-panel/95",
          item.type === "info" && "border-line2 bg-panel/95",
        )}
      >
        {item.type === "success" && (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-teal" />
        )}
        {item.type === "error" && (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
        )}
        {item.type === "info" && (
          <Info className="mt-0.5 size-4 shrink-0 text-accent" />
        )}
        <div className="flex-1 text-label leading-relaxed text-ink">
          {item.message}
        </div>
        <button
          type="button"
          onClick={() => dismiss(item.id)}
          aria-label={`关闭通知：${item.message}`}
          className="-m-1 rounded p-1 text-faint transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <X className="size-3.5" />
        </button>
      </div>
    ));

  return (
    <>
      {/*
        Two regions, not one: a failure interrupting the reader matters more than
        a "saved" confirmation, and `aria-live="polite"` queues it behind whatever
        is being announced. Both regions stay mounted so assistive tech registers
        them before any toast arrives.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
      >
        {render(routine)}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
      >
        {render(failures)}
      </div>
    </>
  );
}
