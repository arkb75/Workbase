import {
  resolveKnowledgeChangeAction,
  startProjectKnowledgeRefreshAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { buildKnowledgeReviewInbox } from "@/src/lib/knowledge-review-inbox";
import type { KnowledgeReviewInboxCounts } from "@/src/lib/knowledge-review-inbox";
import { formatDateTime, titleCase } from "@/src/lib/utils";

export interface KnowledgeUpdateInboxProps {
  workItemId: string;
  refreshes: Array<{
    id: string;
    status: string;
    trigger: string;
    targetHeads: unknown;
    progress: unknown;
    qualityStatus: string;
    coverage: unknown;
    orchestration: unknown;
    budgetUsage: unknown;
    createdAt: string;
    finishedAt: string | null;
  }>;
  changes: Array<{
    id: string;
    entityId: string;
    entityKind: "evidence" | "highlight" | "project_fact" | "artifact";
    action: string;
    reason: string;
    createdAt: string;
    primary: string;
    secondary: string | null;
    primaryField: "title" | "text" | "statement" | "content";
    secondaryField: "summary" | "content" | null;
    category: string | null;
    visibility: string | null;
    sensitivityFlag: boolean;
    lifecycleStatus: string;
    publicSafetyStatus: string | null;
    beforeSnapshot: unknown;
    afterSnapshot: unknown;
    provenance: unknown;
    downstreamImpact: unknown;
  }>;
  counts?: KnowledgeReviewInboxCounts;
}

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function targetLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const target = objectRecord(entry);
    return typeof target?.repository === "string" && typeof target.commitSha === "string"
      ? [`${target.repository}@${target.commitSha.slice(0, 8)}`]
      : [];
  });
}

function compactDiff(value: unknown) {
  const record = objectRecord(value);
  if (!record) return null;
  return Object.entries(record)
    .filter(([, field]) => typeof field === "string" || typeof field === "number" || typeof field === "boolean")
    .slice(0, 8)
    .map(([key, field]) => `${titleCase(key)}: ${String(field)}`)
    .join(" · ");
}

function coverageSummary(value: unknown): { semanticPaths: number; analyzedPaths: number; gaps: string[] } {
  if (!Array.isArray(value)) return { semanticPaths: 0, analyzedPaths: 0, gaps: [] as string[] };
  return value.reduce<{ semanticPaths: number; analyzedPaths: number; gaps: string[] }>((summary, entry) => {
    const row = objectRecord(entry);
    const gaps = Array.isArray(row?.coverageGaps)
      ? row.coverageGaps.filter((gap): gap is string => typeof gap === "string")
      : [];
    return {
      semanticPaths: summary.semanticPaths + (typeof row?.semanticPaths === "number" ? row.semanticPaths : 0),
      analyzedPaths: summary.analyzedPaths + (typeof row?.analyzedPaths === "number" ? row.analyzedPaths : 0),
      gaps: [...summary.gaps, ...gaps],
    };
  }, { semanticPaths: 0, analyzedPaths: 0, gaps: [] as string[] });
}

function toneForStatus(status: string) {
  if (status === "completed" || status === "active" || status === "verified") return "success" as const;
  if (status === "failed" || status === "quarantined" || status === "retired") return "danger" as const;
  if (status === "pending" || status === "pending_review" || status === "analyzing" || status === "inventorying" || status === "reconciling") return "warning" as const;
  return "neutral" as const;
}

type InboxChange = KnowledgeUpdateInboxProps["changes"][number];

function KnowledgeChangeReviewCard({ workItemId, change }: { workItemId: string; change: InboxChange }) {
  const before = compactDiff(change.beforeSnapshot);
  const after = compactDiff(change.afterSnapshot);
  const isQuarantined = change.action === "quarantined" || change.lifecycleStatus === "quarantined";
  return (
    <article className="grid gap-4 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={change.action === "quarantined" ? "danger" : change.action === "retired" ? "warning" : "accent"}>
            {titleCase(change.action)}
          </Badge>
          <Badge>{titleCase(change.entityKind)}</Badge>
          <Badge tone={toneForStatus(change.lifecycleStatus)}>{titleCase(change.lifecycleStatus)}</Badge>
          {change.publicSafetyStatus ? (
            <Badge tone={toneForStatus(change.publicSafetyStatus)}>Public: {titleCase(change.publicSafetyStatus)}</Badge>
          ) : null}
          {change.sensitivityFlag ? <Badge tone="warning">Sensitive</Badge> : null}
        </div>
        <p className="mt-3 text-sm font-medium leading-6 text-[color:var(--ink-strong)]">{change.primary}</p>
        {change.secondary ? <p className="mt-1 line-clamp-3 text-sm leading-6 text-[color:var(--ink-soft)]">{change.secondary}</p> : null}
        <p className="mt-2 text-xs leading-5 text-[color:var(--ink-muted)]">{change.reason}</p>
        {isQuarantined ? (
          <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-900">
            This item failed an automatic safety or validation gate and is not active. Edit it to create a reviewed successor, revert the automated change, or retire it explicitly.
          </p>
        ) : null}
        {before || after || change.provenance ? (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer font-medium text-[color:var(--accent)]">View version diff and provenance</summary>
            <div className="mt-3 grid gap-3 border-l border-black/10 pl-4 text-[color:var(--ink-soft)]">
              {before ? <p><span className="font-semibold text-[color:var(--ink-strong)]">Before</span><br />{before}</p> : null}
              {after ? <p><span className="font-semibold text-[color:var(--ink-strong)]">After</span><br />{after}</p> : null}
              {change.provenance ? <pre className="max-h-44 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5">{JSON.stringify(change.provenance, null, 2)}</pre> : null}
            </div>
          </details>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 lg:max-w-80 lg:justify-end">
        {!isQuarantined ? (
          <form action={resolveKnowledgeChangeAction}>
            <input type="hidden" name="changeId" value={change.id} />
            <input type="hidden" name="workItemId" value={workItemId} />
            <input type="hidden" name="decision" value="keep" />
            <SubmitButton pendingLabel="Keeping..." size="sm">Keep</SubmitButton>
          </form>
        ) : null}
        <form action={resolveKnowledgeChangeAction}>
          <input type="hidden" name="changeId" value={change.id} />
          <input type="hidden" name="workItemId" value={workItemId} />
          <input type="hidden" name="decision" value="revert" />
          <SubmitButton pendingLabel="Reverting..." variant="secondary" size="sm">Revert</SubmitButton>
        </form>
        <form action={resolveKnowledgeChangeAction}>
          <input type="hidden" name="changeId" value={change.id} />
          <input type="hidden" name="workItemId" value={workItemId} />
          <input type="hidden" name="decision" value="retire" />
          <SubmitButton pendingLabel="Retiring..." variant="danger" size="sm">Retire</SubmitButton>
        </form>
        <details className="w-full text-xs lg:text-right">
          <summary className="cursor-pointer py-2 font-medium text-[color:var(--accent)]">
            {isQuarantined ? "Edit into a reviewed successor" : "Edit and keep"}
          </summary>
          <form action={resolveKnowledgeChangeAction} className="mt-2 grid gap-2 text-left">
            <input type="hidden" name="changeId" value={change.id} />
            <input type="hidden" name="workItemId" value={workItemId} />
            <input type="hidden" name="decision" value="edit_and_keep" />
            {change.primaryField === "content" ? (
              <Textarea name="content" defaultValue={change.primary} className="min-h-28" />
            ) : (
              <Input name={change.primaryField} defaultValue={change.primary} />
            )}
            {change.secondaryField === "content" ? <Textarea name="content" defaultValue={change.secondary ?? ""} className="min-h-28" /> : null}
            {change.secondaryField === "summary" ? <Textarea name="summary" defaultValue={change.secondary ?? ""} /> : null}
            {change.category ? (
              <Select name="category" defaultValue={change.category}>
                {['architecture', 'behavior', 'data_flow', 'code_location', 'dependency', 'configuration'].map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
              </Select>
            ) : null}
            {change.visibility ? (
              <Select name="visibility" defaultValue={change.visibility}>
                {['private', 'resume_safe', 'linkedin_safe', 'public_safe'].map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
              </Select>
            ) : null}
            <Textarea name="reviewNotes" placeholder="Review notes" />
            <SubmitButton pendingLabel="Saving successor..." size="sm">
              {isQuarantined ? "Save reviewed successor" : "Save successor"}
            </SubmitButton>
          </form>
        </details>
      </div>
    </article>
  );
}

export function KnowledgeUpdateInbox({ workItemId, refreshes, changes, counts }: KnowledgeUpdateInboxProps) {
  const latest = refreshes[0] ?? null;
  const targets = latest ? targetLabels(latest.targetHeads) : [];
  const coverage = coverageSummary(latest?.coverage);
  const queue = buildKnowledgeReviewInbox(changes, { counts });
  return (
    <section id="knowledge-updates" className="scroll-mt-24 border-t border-black/8 pt-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--accent)]">
            Review later
          </p>
          <h3 className="mt-2 font-display text-2xl font-semibold tracking-[-0.035em] text-[color:var(--ink-strong)]">
            Knowledge updates
          </h3>
          <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
            Verified repository changes can be active immediately. Quarantined changes stay outside active knowledge; review, revise, revert, or retire every update without losing its previous versions.
          </p>
        </div>
        <form action={startProjectKnowledgeRefreshAction}>
          <input type="hidden" name="workItemId" value={workItemId} />
          <SubmitButton pendingLabel="Starting refresh..." variant="secondary">
            Refresh repository knowledge
          </SubmitButton>
        </form>
      </div>

      <div className="mt-5 border-y border-black/8 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.15em] text-[color:var(--ink-muted)]">
            Latest refresh
          </span>
          {latest ? <Badge tone={toneForStatus(latest.status)}>{titleCase(latest.status)}</Badge> : <Badge>Not started</Badge>}
          {latest ? <Badge tone={toneForStatus(latest.qualityStatus)}>Quality: {titleCase(latest.qualityStatus)}</Badge> : null}
          {targets.map((target) => <Badge key={target}>{target}</Badge>)}
        </div>
        {latest ? (
          <div className="mt-2 text-xs leading-5 text-[color:var(--ink-soft)]">
            <p>
              {titleCase(latest.trigger)} · started {formatDateTime(latest.createdAt)}
              {latest.finishedAt ? ` · completed ${formatDateTime(latest.finishedAt)}` : ""}
              {coverage.analyzedPaths ? ` · ${coverage.semanticPaths}/${coverage.analyzedPaths} files semantically analyzed` : ""}
            </p>
            {coverage.gaps.length ? (
              <details className="mt-2">
                <summary className="cursor-pointer font-medium text-[color:var(--accent)]">
                  {coverage.gaps.length} semantic coverage gap{coverage.gaps.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {coverage.gaps.slice(0, 20).map((gap) => <li key={gap}>{gap}</li>)}
                </ul>
              </details>
            ) : null}
            {latest.orchestration || latest.budgetUsage ? (
              <details className="mt-2">
                <summary className="cursor-pointer font-medium text-[color:var(--accent)]">View orchestration audit</summary>
                <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5">{JSON.stringify({ orchestration: latest.orchestration, budgetUsage: latest.budgetUsage }, null, 2)}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>

      {queue.totalKnowledgeCount || queue.totalProvenanceCount ? (
        <div className="grid gap-px border-y border-black/8 bg-black/8 sm:grid-cols-3">
          <div className="bg-[color:var(--surface)] px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">New or updated</p>
            <p className="mt-1 text-2xl font-semibold text-[color:var(--ink-strong)]">{queue.newOrUpdatedKnowledgeCount}</p>
          </div>
          <div className="bg-[color:var(--surface)] px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">Needs attention</p>
            <p className="mt-1 text-2xl font-semibold text-[color:var(--ink-strong)]">{queue.needsAttentionCount}</p>
          </div>
          <div className="bg-[color:var(--surface)] px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">Evidence provenance</p>
            <p className="mt-1 text-2xl font-semibold text-[color:var(--ink-strong)]">{queue.totalProvenanceCount}</p>
          </div>
        </div>
      ) : null}

      <div className="divide-y divide-black/8">
        {queue.knowledgeChanges.map((change) => (
          <KnowledgeChangeReviewCard key={change.id} workItemId={workItemId} change={change} />
        ))}
        {queue.deferredKnowledgeCount ? (
          <p className="py-5 text-xs leading-5 text-[color:var(--ink-soft)]">
            {queue.deferredKnowledgeCount} more knowledge update{queue.deferredKnowledgeCount === 1 ? " is" : "s are"} safely queued. Resolve a visible card to advance the bounded review queue.
          </p>
        ) : null}
        {!queue.totalKnowledgeCount && !queue.totalProvenanceCount ? (
          <p className="py-6 text-sm leading-6 text-[color:var(--ink-soft)]">
            No unreviewed knowledge changes. Automatic updates will appear here without blocking chat or safe artifact generation.
          </p>
        ) : null}
      </div>

      {queue.totalProvenanceCount ? (
        <details className="border-t border-black/8 py-5">
          <summary className="cursor-pointer text-sm font-semibold text-[color:var(--ink-strong)]">
            Review {queue.totalProvenanceCount} exact evidence provenance update{queue.totalProvenanceCount === 1 ? "" : "s"}
          </summary>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[color:var(--ink-soft)]">
            File excerpts remain commit- and line-pinned audit records beneath Facts and Highlights. They are collapsed and shown eight at a time so provenance does not overwhelm the user-facing knowledge queue.
          </p>
          <div className="mt-3 divide-y divide-black/8 border-y border-black/8">
            {queue.provenanceChanges.map((change) => (
              <KnowledgeChangeReviewCard key={change.id} workItemId={workItemId} change={change} />
            ))}
            {queue.deferredProvenanceCount ? (
              <p className="py-5 text-xs leading-5 text-[color:var(--ink-soft)]">
                {queue.deferredProvenanceCount} more provenance update{queue.deferredProvenanceCount === 1 ? " is" : "s are"} preserved in the audit queue and will surface as this batch is reviewed.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
