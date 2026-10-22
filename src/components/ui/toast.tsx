"use client";

import { useEffect, useState } from "react";
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

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handleToast: ToastListener = (item) => {
      setToasts((prev) => [...prev.slice(-3), item]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== item.id));
      }, 4200);
    };

    listeners.add(handleToast);
    return () => {
      listeners.delete(handleToast);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2 pointer-events-none"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className={cn(
            "obsidian-card pointer-events-auto flex items-start gap-3 rounded-xl border p-3.5 shadow-2xl transition-all duration-200",
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
          <div className="flex-1 text-xs leading-relaxed text-ink">
            {item.message}
          </div>
          <button
            type="button"
            onClick={() =>
              setToasts((prev) => prev.filter((t) => t.id !== item.id))
            }
            className="text-faint hover:text-muted transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
