import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/src/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-full text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-[color:var(--accent)] px-4 py-2 text-white hover:bg-[color:var(--accent-strong)]",
        secondary:
          "bg-white px-4 py-2 text-[color:var(--ink-strong)] ring-1 ring-black/10 hover:bg-[color:var(--panel-muted)]",
        ghost:
          "px-3 py-2 text-[color:var(--ink-soft)] hover:bg-black/5 hover:text-[color:var(--ink-strong)]",
        danger:
          "bg-[color:var(--danger)] px-4 py-2 text-white hover:bg-[color:var(--danger-strong)]",
      },
      size: {
        sm: "h-9 min-w-20",
        md: "h-11 min-w-24",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    children: ReactNode;
  };

export function Button({
  children,
  className,
  variant,
  size,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {children}
    </button>
  );
}
