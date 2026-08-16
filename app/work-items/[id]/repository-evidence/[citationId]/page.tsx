import Link from "next/link";
import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, KeyValue } from "@/components/ui/card";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getDemoUser } from "@/src/lib/demo-user";
import { getArchivedRepositoryEvidenceCitation } from "@/src/services/project-chat-repository-evidence-archive-service";

export const dynamic = "force-dynamic";

export default async function RepositoryEvidencePage({
  params,
}: {
  params: Promise<{ id: string; citationId: string }>;
}) {
  const { id, citationId } = await params;
  const user = await getDemoUser();
  const evidence = await getArchivedRepositoryEvidenceCitation({
    userId: user.id,
    workItemId: id,
    citationId,
  });
  if (!evidence) notFound();
  const lines = evidence.output.split("\n");

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Private repository evidence"
        title="Verified Git evidence"
        description="This is the exact redacted command output retained for the cited answer. Workbase verified its content hash, repository snapshot, and cited line range before displaying it."
        actions={(
          <Link
            href={`/work-items/${encodeURIComponent(id)}?tab=chat`}
            className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-4 py-2.5 text-sm font-medium text-[color:var(--ink-strong)] transition hover:border-[color:var(--accent)]/30"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to chat
          </Link>
        )}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{evidence.label}</CardTitle>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
              <ShieldCheck className="h-3.5 w-3.5" />
              Integrity verified
            </span>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KeyValue label="Repository" value={evidence.repository} />
            <KeyValue
              label="Snapshot"
              value={<span className="font-mono text-xs">{evidence.snapshotCommitSha}</span>}
            />
            <KeyValue label="Cited output" value={`Lines ${evidence.citedRange.startLine}–${evidence.citedRange.endLine}`} />
            <KeyValue label="Evidence hash" value={<span className="font-mono text-xs">{evidence.outputHash.slice(0, 16)}…</span>} />
          </div>

          <div className="rounded-2xl border border-black/8 bg-[color:var(--panel-muted)] p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
              Executed command
            </p>
            <code className="break-all text-sm text-[color:var(--ink-strong)]">{evidence.command}</code>
          </div>

          <div className="flex flex-wrap gap-3 text-sm">
            {evidence.targetUrl ? (
              <a
                href={evidence.targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-2 font-medium text-white"
              >
                Open exact GitHub target <ExternalLink className="h-4 w-4" />
              </a>
            ) : null}
            {evidence.snapshotUrl ? (
              <a
                href={evidence.snapshotUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-4 py-2 font-medium text-[color:var(--ink-strong)]"
              >
                Open inspected snapshot <ExternalLink className="h-4 w-4" />
              </a>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retained command output</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-h-[70vh] overflow-auto rounded-2xl border border-black/10 bg-[#0d1820] py-3 font-mono text-xs leading-6 text-slate-200">
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              const cited = lineNumber >= evidence.citedRange.startLine && lineNumber <= evidence.citedRange.endLine;
              return (
                <div
                  key={lineNumber}
                  className={`grid grid-cols-[4.5rem_minmax(0,1fr)] px-3 ${cited ? "bg-emerald-300/12" : ""}`}
                >
                  <span className={`select-none pr-4 text-right ${cited ? "text-emerald-300" : "text-slate-500"}`}>
                    {lineNumber}
                  </span>
                  <span className="whitespace-pre-wrap break-words">{line || " "}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </WorkbaseFrame>
  );
}
