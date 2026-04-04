import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, LayoutGrid, Plus, Sparkles, UserRound } from "lucide-react";

export function WorkbaseFrame({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[color:var(--bg)]">
      <header className="sticky top-0 z-30 border-b border-black/8 bg-white/88 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-6 px-6 py-4">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 text-[color:var(--ink-strong)]"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[color:var(--accent)] text-white shadow-[0_18px_36px_rgba(15,118,110,0.24)]">
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

          <nav className="flex items-center gap-2 text-sm">
            <Link
              className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 font-medium text-[color:var(--ink-soft)] transition hover:bg-black/5 hover:text-[color:var(--ink-strong)]"
              href="/dashboard"
            >
              <LayoutGrid className="h-4 w-4" />
              Dashboard
            </Link>
            <Link
              className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-2.5 font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)] [color:white] [&_svg]:text-white"
              href="/work-items/new"
            >
              <Plus className="h-4 w-4" />
              New Work Item
            </Link>
            <Link
              className="inline-flex items-center gap-2 rounded-full border border-[color:var(--accent)]/20 bg-[color:var(--surface)] px-4 py-2.5 font-medium text-[color:var(--ink-strong)] shadow-[0_8px_20px_rgba(16,33,43,0.06)] transition hover:border-[color:var(--accent)]/35 hover:bg-white"
              href="/onboarding"
            >
              <UserRound className="h-4 w-4 text-[color:var(--accent)]" />
              Profile
              <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8">
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
    <section className="grid gap-6 rounded-[32px] border border-black/8 bg-white/82 p-7 shadow-[0_20px_60px_rgba(15,23,42,0.06)] md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-4">
        {eyebrow ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-[color:var(--panel-muted)] px-3 py-1 text-xs uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">
            <Sparkles className="h-3.5 w-3.5" />
            {eyebrow}
          </div>
        ) : null}
        <div className="space-y-3">
          <h1 className="font-display text-3xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)] sm:text-4xl">
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
