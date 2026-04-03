import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, Sparkles } from "lucide-react";

export function WorkbaseFrame({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[color:var(--bg)]">
      <header className="border-b border-black/6 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 text-[color:var(--ink-strong)]"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[color:var(--accent)] text-white shadow-[0_14px_28px_rgba(8,145,178,0.22)]">
              <BriefcaseBusiness className="h-5 w-5" />
            </div>
            <div>
              <p className="font-display text-lg font-semibold tracking-[-0.05em]">
                Workbase
              </p>
              <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                Verified career content
              </p>
            </div>
          </Link>

          <nav className="flex items-center gap-2 text-sm text-[color:var(--ink-soft)]">
            <Link className="rounded-full px-3 py-2 hover:bg-black/5" href="/dashboard">
              Dashboard
            </Link>
            <Link
              className="rounded-full px-3 py-2 hover:bg-black/5"
              href="/work-items/new"
            >
              New Work Item
            </Link>
            <Link
              className="flex items-center gap-2 rounded-full bg-[color:var(--ink-strong)] px-4 py-2 text-white"
              href="/onboarding"
            >
              Profile
              <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section className="grid gap-6 rounded-[32px] bg-[color:var(--surface)] p-8 shadow-[0_24px_90px_rgba(15,23,42,0.08)] md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-4">
        {eyebrow ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">
            <Sparkles className="h-3.5 w-3.5" />
            {eyebrow}
          </div>
        ) : null}
        <div className="space-y-3">
          <h1 className="font-display text-4xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)] sm:text-5xl">
            {title}
          </h1>
          <p className="max-w-2xl text-base leading-7 text-[color:var(--ink-soft)]">
            {description}
          </p>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </section>
  );
}
