import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/src/lib/utils";

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-28 w-full rounded-[24px] border border-black/10 bg-white px-4 py-3 text-sm leading-6 text-[color:var(--ink-strong)] outline-none transition placeholder:text-[color:var(--ink-muted)] focus:border-[color:var(--accent)] focus:ring-3 focus:ring-cyan-100",
        className,
      )}
      {...props}
    />
  );
}
