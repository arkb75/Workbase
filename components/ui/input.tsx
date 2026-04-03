import type { InputHTMLAttributes } from "react";
import { cn } from "@/src/lib/utils";

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-2xl border border-black/10 bg-white px-4 text-sm text-[color:var(--ink-strong)] outline-none transition placeholder:text-[color:var(--ink-muted)] focus:border-[color:var(--accent)] focus:ring-3 focus:ring-cyan-100",
        className,
      )}
      {...props}
    />
  );
}
