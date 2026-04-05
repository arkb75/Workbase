import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/src/lib/utils";

export function CollapsibleCard({
  title,
  description,
  meta,
  children,
  defaultOpen = false,
  className,
  bodyClassName,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <details
      className={cn(
        "collapsible-card rounded-[28px] border border-black/8 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.06)]",
        className,
      )}
      open={defaultOpen}
    >
      <summary className="collapsible-card__summary">
        <div className="min-w-0 space-y-2">
          <h3 className="font-display text-xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)]">
            {title}
          </h3>
          {description ? (
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">{description}</p>
          ) : null}
        </div>
        <div className="flex flex-shrink-0 items-start gap-3">
          {meta ? <div className="flex flex-wrap items-center justify-end gap-2">{meta}</div> : null}
          <span className="collapsible-card__chevron" aria-hidden="true">
            <ChevronDown className="h-4 w-4" />
          </span>
        </div>
      </summary>

      <div className="collapsible-card__body">
        <div className="collapsible-card__inner">
          <div className={cn("border-t border-black/6 px-6 py-6", bodyClassName)}>{children}</div>
        </div>
      </div>
    </details>
  );
}
