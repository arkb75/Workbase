"use client";

import { type CSSProperties, useMemo, useState } from "react";
import { Clock3, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTime } from "@/src/lib/utils";

type UsedHighlight = {
  id: string;
  text: string;
  summary: string;
  visibility: string;
  confidence: string;
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
  type: string;
  targetAngle: string;
  tone: string;
  content: string;
  createdAt: string;
  highlightCount: number;
  evidenceCount: number;
  fallbackUsed: boolean;
  fallbackNote: string | null;
  hasTrace: boolean;
  usedHighlights: UsedHighlight[];
  fallbackHighlights: FallbackHighlight[];
  supportingEvidence: SupportingEvidence[];
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

              <div className="rounded-[26px] border border-black/8 bg-white p-5 shadow-[0_18px_36px_rgba(15,23,42,0.04)]">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-[color:var(--ink-strong)]">
                  {selectedEntry.content}
                </pre>
              </div>

              <div className="grid gap-5 xl:grid-cols-[0.94fr_1.06fr]">
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

                <div className="grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      Supporting evidence
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                      Supporting evidence expands context around the selected highlight set without
                      quietly introducing hidden accomplishments.
                    </p>
                  </div>

                  {selectedEntry.supportingEvidence.length ? (
                    <div className="grid max-h-[36rem] gap-3 overflow-y-auto pr-1">
                      {selectedEntry.supportingEvidence.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-[22px] border border-black/8 bg-white p-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{item.type.replace(/_/g, " ")}</Badge>
                            <Badge>{item.sourceLabel}</Badge>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                            {item.title}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                            {item.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      No supporting evidence was recorded for this artifact run.
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
