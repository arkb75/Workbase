import type { SelectHTMLAttributes } from "react";
import { cn } from "@/src/lib/utils";

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 w-full rounded-2xl border border-black/10 bg-white px-4 text-sm text-[color:var(--ink-strong)] outline-none transition focus:border-[color:var(--accent)] focus:ring-3 focus:ring-cyan-100",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
