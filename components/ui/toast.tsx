"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, X, TriangleAlert } from "lucide-react";
import { cn } from "@/src/lib/utils";

type ToastTone = "info" | "success" | "warning" | "danger";

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
};

type ToastRecord = ToastInput & {
  id: string;
};

const toneClasses: Record<ToastTone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-950",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  danger: "border-rose-200 bg-rose-50 text-rose-950",
};

const toneIcons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle,
} satisfies Record<ToastTone, typeof Info>;

const ToastContext = createContext<{
  pushToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timeoutRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    ({ tone = "info", durationMs = 4200, ...toast }: ToastInput) => {
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setToasts((current) => [...current, { id, tone, durationMs, ...toast }]);

      const timeoutId = setTimeout(() => {
        dismissToast(id);
      }, durationMs);

      timeoutRefs.current.set(id, timeoutId);
    },
    [dismissToast],
  );

  useEffect(() => {
    const timeoutMap = timeoutRefs.current;

    return () => {
      for (const timeoutId of timeoutMap.values()) {
        clearTimeout(timeoutId);
      }

      timeoutMap.clear();
    };
  }, []);

  const value = useMemo(
    () => ({
      pushToast,
      dismissToast,
    }),
    [dismissToast, pushToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4 sm:inset-x-auto sm:right-4 sm:left-auto sm:top-6 sm:block sm:w-[380px]">
        <div className="grid w-full max-w-[380px] gap-3">
          {toasts.map((toast) => {
            const Icon = toneIcons[toast.tone ?? "info"];

            return (
              <div
                key={toast.id}
                className={cn(
                  "pointer-events-auto rounded-[24px] border p-4 shadow-[0_18px_48px_rgba(15,23,42,0.18)] backdrop-blur-sm transition",
                  toneClasses[toast.tone ?? "info"],
                )}
                role="status"
                aria-live="polite"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full bg-white/80 p-1.5 shadow-sm">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{toast.title}</p>
                    {toast.description ? (
                      <p className="mt-1 text-sm leading-6 opacity-85">{toast.description}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissToast(toast.id)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/65 transition hover:bg-white"
                    aria-label="Dismiss notification"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast must be used within a ToastProvider.");
  }

  return context;
}
