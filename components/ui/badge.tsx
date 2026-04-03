import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/src/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-black/5 text-[color:var(--ink-soft)]",
        success: "bg-emerald-100 text-emerald-800",
        warning: "bg-amber-100 text-amber-900",
        danger: "bg-rose-100 text-rose-800",
        accent: "bg-cyan-100 text-cyan-800",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

type BadgeProps = VariantProps<typeof badgeVariants> & {
  children: ReactNode;
  className?: string;
};

export function Badge({ children, className, tone }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}
