"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { Plus, X } from "lucide-react";

export function SourceAddControl({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--accent)] text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)] focus:outline-none focus:ring-3 focus:ring-cyan-100 [color:white] [&_svg]:text-white"
        aria-label="Add source"
        title="Add source"
      >
        <Plus className="h-5 w-5" />
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
          <button
            type="button"
            className="absolute inset-0 bg-[rgba(16,33,43,0.42)] backdrop-blur-[2px]"
            aria-label="Close add source dialog"
            onClick={() => setIsOpen(false)}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative z-10 grid max-h-[min(90vh,44rem)] w-full max-w-2xl overflow-hidden rounded-[30px] border border-black/8 bg-white shadow-[0_28px_90px_rgba(15,23,42,0.24)]"
          >
            <header className="flex items-start justify-between gap-4 border-b border-black/6 p-6">
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                  Add source
                </p>
                <h2
                  id={titleId}
                  className="font-display text-2xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)]"
                >
                  Manual notes
                </h2>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Capture decisions, context, and work that is not visible in repository history.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-black/8 bg-white text-[color:var(--ink-muted)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--ink-strong)]"
                aria-label="Close add source dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="overflow-y-auto p-6">{children}</div>
          </section>
        </div>
      ) : null}
    </>
  );
}
