import Link from "next/link";
import type { ReactNode } from "react";
import { Archive, Database, MessageSquareText, Sparkles } from "lucide-react";
import { cn } from "@/src/lib/utils";
import type { WorkItemWorkspaceTab } from "@/src/lib/work-item-workspace-tabs";

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
    id: "chat",
    label: "Chat",
    description: "Ask, research, capture context, and create reviewed outputs.",
    icon: MessageSquareText,
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

export function WorkItemWorkspace({
  activeTab,
  tabHrefs,
  sourcesPanel,
  highlightsPanel,
  artifactsPanel,
  chatPanel,
}: {
  activeTab: WorkItemWorkspaceTab;
  tabHrefs: Record<WorkItemWorkspaceTab, string>;
  sourcesPanel: ReactNode | null;
  highlightsPanel: ReactNode | null;
  artifactsPanel: ReactNode | null;
  chatPanel: ReactNode | null;
}) {
  const activePanel = {
    sources: sourcesPanel,
    highlights: highlightsPanel,
    artifacts: artifactsPanel,
    chat: chatPanel,
  }[activeTab];

  return (
    <section className="grid gap-5">
      <div className="rounded-[30px] border border-black/8 bg-white/86 p-2 shadow-[0_18px_54px_rgba(15,23,42,0.06)]">
        <nav
          className="grid gap-2 md:grid-cols-2 xl:grid-cols-4"
          aria-label="Work Item sections"
        >
          {tabConfig.map((item) => {
            const isActive = item.id === activeTab;
            const Icon = item.icon;

            return (
              <Link
                key={item.id}
                href={tabHrefs[item.id]}
                replace
                scroll={false}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
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
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="relative">
        {activePanel}
      </div>
    </section>
  );
}
