"use client";

import { type CSSProperties, useMemo, useState } from "react";
import { editKnowledgeItemAction, refreshStaleArtifactAction, retireKnowledgeItemAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Clock3, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime } from "@/src/lib/utils";

type UsedHighlight = {
  id: string;
  text: string;
  summary: string;
  visibility: string;
  confidence: string;
  provenance: SupportingEvidence[];
};

type FallbackHighlight = {
  id: string;
  text: string;
  summary: string;
  confidence: string;
  ownershipClarity: string;
};

type SupportingEvidence = {
  id: string;
  title: string;
  content: string;
  type: string;
  sourceLabel: string;
};

export type ArtifactHistoryEntry = {
  id: string;
  workItemId: string;
  type: string;
  targetAngle: string;
  tone: string;
  content: string;
  lifecycleStatus: string;
  publicSafetyStatus: string;
  staleReason: string | null;
  createdAt: string;
  highlightCount: number;
  evidenceCount: number;
  fallbackUsed: boolean;
  fallbackNote: string | null;
  hasTrace: boolean;
  usedHighlights: UsedHighlight[];
  fallbackHighlights: FallbackHighlight[];
};

export function ArtifactHistoryPanel({
  entries,
  initialSelectedArtifactId,
}: {
  entries: ArtifactHistoryEntry[];
  initialSelectedArtifactId?: string | null;
}) {
  const [isLibraryOpen, setIsLibraryOpen] = useState(true);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    initialSelectedArtifactId && entries.some((entry) => entry.id === initialSelectedArtifactId)
      ? initialSelectedArtifactId
      : entries[0]?.id ?? null,
  );

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedArtifactId) ?? entries[0] ?? null,
    [entries, selectedArtifactId],
  );
  const libraryMotionStyle = {
    "--artifact-library-width": entries.length && isLibraryOpen ? "32rem" : "0rem",
    "--artifact-library-gap": entries.length && isLibraryOpen ? "1.5rem" : "0rem",
  } as CSSProperties;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-4 border-b border-black/6 pb-6 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <CardTitle>Artifact history</CardTitle>
          <CardDescription>
            The saved artifact library opens beside the selected output so previous versions stay
            easy to scan without losing the current artifact lineage.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-black/8 bg-[color:var(--panel-muted)] px-4 py-2 text-sm text-[color:var(--ink-soft)]">
            <Clock3 className="h-4 w-4 text-[color:var(--accent)]" />
            {entries.length} saved
          </div>
        </div>
      </CardHeader>

      <CardContent
        className={cn(
          "flex flex-col p-6 transition-[gap] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] xl:flex-row",
          entries.length ? "gap-6 xl:gap-[var(--artifact-library-gap)]" : "gap-0",
        )}
        style={libraryMotionStyle}
      >
        {entries.length ? (
          <section
            aria-hidden={!isLibraryOpen}
            className={cn(
              "flex min-w-0 self-stretch overflow-hidden rounded-[26px] border border-black/8 bg-[color:var(--panel-muted)]/65 transition-[max-width,opacity,transform,padding,border-color] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
              isLibraryOpen
                ? "translate-x-0 p-4 opacity-100 xl:max-w-[var(--artifact-library-width)]"
                : "max-h-0 -translate-x-3 border-transparent p-0 opacity-0 xl:max-h-none xl:max-w-0",
            )}
          >
            <div className="flex min-h-0 w-full flex-col">
              <div className="mb-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                  Saved artifacts
                </p>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                {entries.map((entry) => {
                  const isSelected = selectedEntry?.id === entry.id;

                  return (
                    <button
                      key={entry.id}
                      type="button"
                      tabIndex={isLibraryOpen ? 0 : -1}
                      onClick={() => setSelectedArtifactId(entry.id)}
                      className={cn(
                        "rounded-[22px] border p-4 text-left transition",
                        isSelected
                          ? "border-[color:var(--accent)] bg-white shadow-[0_18px_36px_rgba(19,120,111,0.12)]"
                          : "border-black/8 bg-white/82 hover:border-[color:var(--accent)]/45 hover:bg-white",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={isSelected ? "accent" : "neutral"}>
                          {entry.type.replace(/_/g, " ")}
                        </Badge>
                        <Badge>{entry.targetAngle.replace(/_/g, " ")}</Badge>
                        <Badge>{entry.tone.replace(/_/g, " ")}</Badge>
                        {entry.fallbackUsed ? <Badge tone="warning">fallback</Badge> : null}
                        {entry.lifecycleStatus !== "active" ? (
                          <Badge tone="warning">{entry.lifecycleStatus.replace(/_/g, " ")}</Badge>
                        ) : null}
                      </div>
                      <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                        {formatDateTime(entry.createdAt)}
                      </p>
                      <p className="mt-3 line-clamp-3 text-sm leading-6 text-[color:var(--ink-soft)]">
                        {entry.content}
                      </p>
                      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                        <span>{entry.highlightCount} highlights</span>
                        <span>•</span>
                        <span>{entry.evidenceCount} evidence refs</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        ) : null}

        <section className="min-w-0 flex-1 transition-[flex-basis] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]">
          {selectedEntry ? (
            <div className="relative grid gap-5 rounded-[30px] border border-black/8 bg-[linear-gradient(180deg,rgba(248,250,249,0.98),rgba(240,246,244,0.96))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
              {entries.length ? (
                <button
                  type="button"
                  onClick={() => setIsLibraryOpen((open) => !open)}
                  aria-label={isLibraryOpen ? "Collapse artifact library" : "Expand artifact library"}
                  title={isLibraryOpen ? "Collapse artifact library" : "Expand artifact library"}
                  className="absolute right-6 top-6 inline-flex h-9 w-9 items-center justify-center rounded-full border border-black/8 bg-white text-[color:var(--ink-muted)] shadow-[0_12px_28px_rgba(15,23,42,0.06)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--ink-strong)]"
                >
                  {isLibraryOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeftOpen className="h-4 w-4" />
                  )}
                </button>
              ) : null}

              <div className="flex flex-wrap items-start justify-between gap-4 pr-12">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{selectedEntry.type.replace(/_/g, " ")}</Badge>
                    <Badge>{selectedEntry.targetAngle.replace(/_/g, " ")}</Badge>
                    <Badge>{selectedEntry.tone.replace(/_/g, " ")}</Badge>
                    <Badge tone={selectedEntry.lifecycleStatus === "active" ? "success" : "warning"}>
                      {selectedEntry.lifecycleStatus.replace(/_/g, " ")}
                    </Badge>
                    <Badge>Public: {selectedEntry.publicSafetyStatus.replace(/_/g, " ")}</Badge>
                    {selectedEntry.fallbackUsed ? <Badge tone="warning">unreviewed fallback used</Badge> : null}
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      Selected artifact
                    </p>
                    <p className="mt-1 text-sm leading-6 text-[color:var(--ink-soft)]">
                      {formatDateTime(selectedEntry.createdAt)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="rounded-full border border-black/8 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                    {selectedEntry.highlightCount} highlights used
                  </div>
                  <div className="rounded-full border border-black/8 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                    {selectedEntry.evidenceCount} evidence refs
                  </div>
                </div>
              </div>

              {selectedEntry.fallbackUsed && selectedEntry.fallbackNote ? (
                <div className="rounded-[24px] border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm leading-6 text-amber-900">{selectedEntry.fallbackNote}</p>
                </div>
              ) : null}

              {selectedEntry.staleReason ? (
                <div className="rounded-[24px] border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-medium text-amber-950">This historical artifact needs refresh.</p>
                  <p className="mt-1 text-sm leading-6 text-amber-900">{selectedEntry.staleReason}</p>
                  <form action={refreshStaleArtifactAction} className="mt-3">
                    <input type="hidden" name="workItemId" value={selectedEntry.workItemId} />
                    <input type="hidden" name="artifactId" value={selectedEntry.id} />
                    <SubmitButton pendingLabel="Refreshing artifact..." size="sm">Generate current successor</SubmitButton>
                  </form>
                </div>
              ) : null}

              <div className="rounded-[26px] border border-black/8 bg-white p-5 shadow-[0_18px_36px_rgba(15,23,42,0.04)]">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-[color:var(--ink-strong)]">
                  {selectedEntry.content}
                </pre>
              </div>

              {selectedEntry.lifecycleStatus === "active" || selectedEntry.lifecycleStatus === "stale" ? (
                <details className="rounded-[22px] border border-black/8 bg-white p-4 text-xs">
                  <summary className="cursor-pointer font-medium text-[color:var(--accent)]">Edit or retire this artifact</summary>
                  <div className="mt-3 grid gap-3">
                    <form action={editKnowledgeItemAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                      <input type="hidden" name="workItemId" value={selectedEntry.workItemId} />
                      <input type="hidden" name="entityId" value={selectedEntry.id} />
                      <input type="hidden" name="kind" value="artifact" />
                      <input type="hidden" name="idempotencyKey" value={`artifact-edit:${selectedEntry.id}:${selectedEntry.createdAt}`} />
                      <Textarea name="value" defaultValue={selectedEntry.content} className="min-h-32" aria-label="Edited artifact content" />
                      <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Save successor</SubmitButton>
                    </form>
                    <form action={retireKnowledgeItemAction} className="flex justify-end">
                      <input type="hidden" name="workItemId" value={selectedEntry.workItemId} />
                      <input type="hidden" name="entityId" value={selectedEntry.id} />
                      <input type="hidden" name="kind" value="artifact" />
                      <input type="hidden" name="reason" value="Retired from Artifact history." />
                      <SubmitButton size="sm" variant="ghost" pendingLabel="Retiring…">Retire artifact</SubmitButton>
                    </form>
                  </div>
                </details>
              ) : null}

              <div className="grid gap-5">
                <div className="grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      Highlights used
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                      Approved highlights stay foregrounded. Fallback highlights are labeled instead
                      of being blended in silently.
                    </p>
                  </div>

                  {selectedEntry.usedHighlights.length ? (
                    <div className="grid gap-3">
                      {selectedEntry.usedHighlights.map((highlight) => (
                        <div
                          key={highlight.id}
                          className="rounded-[22px] border border-black/8 bg-white p-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="success">Approved</Badge>
                            <Badge>{highlight.visibility.replace(/_/g, " ")}</Badge>
                            <Badge>{highlight.confidence}</Badge>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                            {highlight.text}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                            {highlight.summary}
                          </p>
                          {highlight.provenance.length ? (
                            <details className="mt-3 border-l border-black/8 pl-3 text-xs text-[color:var(--ink-muted)]">
                              <summary className="cursor-pointer font-medium text-[color:var(--accent)]">
                                View underlying evidence
                              </summary>
                              <div className="mt-3 grid gap-3">
                                {highlight.provenance.map((item) => (
                                  <div key={item.id} className="grid gap-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge>{item.type.replace(/_/g, " ")}</Badge>
                                      <Badge>{item.sourceLabel}</Badge>
                                    </div>
                                    <p className="font-medium text-[color:var(--ink-strong)]">
                                      {item.title}
                                    </p>
                                    <p className="line-clamp-3 leading-5 text-[color:var(--ink-soft)]">
                                      {item.content}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : selectedEntry.fallbackHighlights.length ? (
                    <div className="grid gap-3">
                      {selectedEntry.fallbackHighlights.map((highlight) => (
                        <div
                          key={highlight.id}
                          className="rounded-[22px] border border-amber-200 bg-amber-50 p-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="warning">Unreviewed fallback</Badge>
                            <Badge>{highlight.confidence}</Badge>
                            <Badge>{highlight.ownershipClarity.replace(/_/g, " ")}</Badge>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                            {highlight.text}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                            {highlight.summary}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : selectedEntry.hasTrace ? (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      This artifact has trace data, but Workbase could not resolve its highlight
                      lineage in the current workspace.
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      This artifact was saved without linked highlight trace data.
                    </p>
                  )}
                </div>

              </div>
            </div>
          ) : (
            <div className="rounded-[30px] border border-dashed border-black/10 bg-[color:var(--panel-muted)]/6 p-8 text-center">
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                Generate an artifact to start building a saved history for this Work Item.
              </p>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
