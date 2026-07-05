"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Archive, Database, Sparkles } from "lucide-react";
import { cn } from "@/src/lib/utils";

export type WorkItemWorkspaceTab = "sources" | "highlights" | "artifacts";

const tabConfig = [
  {
    id: "sources",
    label: "Sources",
    description: "GitHub imports, manual sources, and evidence.",
    icon: Database,
  },
  {
    id: "highlights",
    label: "Highlights",
    description: "Generate, review, approve, and trace highlights.",
    icon: Sparkles,
  },
  {
    id: "artifacts",
    label: "Artifacts",
    description: "Generate outputs and compare saved versions.",
    icon: Archive,
  },
] satisfies Array<{
  id: WorkItemWorkspaceTab;
  label: string;
  description: string;
  icon: typeof Database;
}>;

function readInitialTab(value: string | undefined): WorkItemWorkspaceTab {
  return tabConfig.some((tab) => tab.id === value)
    ? (value as WorkItemWorkspaceTab)
    : "sources";
}

export function WorkItemWorkspace({
  initialTab,
  sourcesPanel,
  highlightsPanel,
  artifactsPanel,
}: {
  initialTab?: string;
  sourcesPanel: ReactNode;
  highlightsPanel: ReactNode;
  artifactsPanel: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<WorkItemWorkspaceTab>(() =>
    readInitialTab(initialTab),
  );
  const panels = useMemo(
    () => ({
      sources: sourcesPanel,
      highlights: highlightsPanel,
      artifacts: artifactsPanel,
    }),
    [sourcesPanel, highlightsPanel, artifactsPanel],
  );
  const selectTab = (nextTab: WorkItemWorkspaceTab) => {
    setActiveTab(nextTab);

    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
  };

  return (
    <section className="grid gap-5">
      <div className="rounded-[30px] border border-black/8 bg-white/86 p-2 shadow-[0_18px_54px_rgba(15,23,42,0.06)]">
        <div className="grid gap-2 lg:grid-cols-3" role="tablist" aria-label="Work Item sections">
          {tabConfig.map((item) => {
            const isActive = item.id === activeTab;
            const Icon = item.icon;

            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`work-item-panel-${item.id}`}
                id={`work-item-tab-${item.id}`}
                onClick={() => selectTab(item.id)}
                className={cn(
                  "grid min-h-28 grid-cols-[auto_1fr] gap-3 rounded-[24px] px-5 py-4 text-left transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  isActive
                    ? "translate-y-0 bg-[color:var(--ink-strong)] text-white shadow-[0_18px_44px_rgba(16,33,43,0.18)]"
                    : "text-[color:var(--ink-soft)] hover:-translate-y-0.5 hover:bg-[color:var(--panel-muted)] hover:text-[color:var(--ink-strong)]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-300",
                    isActive ? "bg-white/12 text-white" : "bg-white text-[color:var(--accent)]",
                  )}
                  aria-hidden="true"
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-sm font-semibold",
                      isActive ? "text-white" : "text-[color:var(--ink-strong)]",
                    )}
                  >
                    {item.label}
                  </span>
                  <span
                    className={cn(
                      "mt-1 block text-sm leading-6",
                      isActive ? "text-white/72" : "text-[color:var(--ink-soft)]",
                    )}
                  >
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative">
        {tabConfig.map((item) => {
          const isActive = item.id === activeTab;

          return (
            <div
              key={item.id}
              id={`work-item-panel-${item.id}`}
              role="tabpanel"
              aria-labelledby={`work-item-tab-${item.id}`}
              aria-hidden={!isActive}
              className={cn(
                "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                isActive
                  ? "relative z-10 translate-y-0 opacity-100"
                  : "pointer-events-none absolute inset-x-0 top-0 -z-10 translate-y-2 opacity-0",
              )}
            >
              {panels[item.id]}
            </div>
          );
        })}
      </div>
    </section>
  );
}
