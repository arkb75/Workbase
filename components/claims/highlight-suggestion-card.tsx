import {
  acceptHighlightSuggestionAction,
  dismissHighlightSuggestionAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  coerceStoredHighlightDraft,
  getDraftEvidenceIds,
} from "@/src/services/highlight-suggestion-service";
import { cn, titleCase } from "@/src/lib/utils";

type SuggestionCardInput = {
  id: string;
  workItemId: string;
  matchReason: string;
  cosineDistance: number | null;
  suggestedDraft: unknown;
  sourceHighlight: {
    id: string;
    text: string;
    summary: string;
    verificationStatus: string;
    visibility: string;
    evidence: Array<{
      evidenceItemId: string;
      evidenceItem: {
        title: string;
      };
    }>;
    tags: Array<{
      dimension: string;
      tag: string;
      score: number | null;
    }>;
  };
};

function diffWords(left: string, right: string) {
  const leftWords = left.split(/(\s+)/);
  const rightWords = right.split(/(\s+)/);
  const table = Array.from({ length: leftWords.length + 1 }, () =>
    Array.from({ length: rightWords.length + 1 }, () => 0),
  );

  for (let leftIndex = leftWords.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightWords.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] =
        leftWords[leftIndex] === rightWords[rightIndex]
          ? table[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
    }
  }

  const removed: Array<{ value: string; changed: boolean }> = [];
  const added: Array<{ value: string; changed: boolean }> = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftWords.length && rightIndex < rightWords.length) {
    if (leftWords[leftIndex] === rightWords[rightIndex]) {
      removed.push({ value: leftWords[leftIndex], changed: false });
      added.push({ value: rightWords[rightIndex], changed: false });
      leftIndex += 1;
      rightIndex += 1;
    } else if (table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1]) {
      removed.push({ value: leftWords[leftIndex], changed: true });
      leftIndex += 1;
    } else {
      added.push({ value: rightWords[rightIndex], changed: true });
      rightIndex += 1;
    }
  }

  while (leftIndex < leftWords.length) {
    removed.push({ value: leftWords[leftIndex], changed: true });
    leftIndex += 1;
  }

  while (rightIndex < rightWords.length) {
    added.push({ value: rightWords[rightIndex], changed: true });
    rightIndex += 1;
  }

  return { removed, added };
}

function DiffText({
  parts,
  tone,
}: {
  parts: Array<{ value: string; changed: boolean }>;
  tone: "removed" | "added";
}) {
  return (
    <p className="text-sm leading-7 text-[color:var(--ink-strong)]">
      {parts.map((part, index) => (
        <span
          key={`${part.value}-${index}`}
          className={cn(
            part.changed && tone === "removed"
              ? "rounded bg-rose-100 px-0.5 text-rose-950 line-through"
              : null,
            part.changed && tone === "added"
              ? "rounded bg-emerald-100 px-0.5 text-emerald-950"
              : null,
          )}
        >
          {part.value}
        </span>
      ))}
    </p>
  );
}

export function HighlightSuggestionCard({
  suggestion,
}: {
  suggestion: SuggestionCardInput;
}) {
  const draft = coerceStoredHighlightDraft(suggestion.suggestedDraft);

  if (!draft) {
    return null;
  }

  const diff = diffWords(suggestion.sourceHighlight.text, draft.text);
  const currentEvidenceIds = new Set(
    suggestion.sourceHighlight.evidence.map((entry) => entry.evidenceItemId),
  );
  const suggestedEvidenceIds = new Set(getDraftEvidenceIds(draft));
  const addedEvidenceCount = Array.from(suggestedEvidenceIds).filter(
    (id) => !currentEvidenceIds.has(id),
  ).length;
  const acceptAction = acceptHighlightSuggestionAction;
  const dismissAction = dismissHighlightSuggestionAction;

  return (
    <article className="rounded-[28px] border border-black/8 bg-white shadow-[0_18px_48px_rgba(15,23,42,0.06)]">
      <div className="border-b border-black/6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">Suggested update</Badge>
              <Badge>{titleCase(suggestion.sourceHighlight.verificationStatus)}</Badge>
              <Badge>{titleCase(suggestion.sourceHighlight.visibility)}</Badge>
              {suggestion.cosineDistance == null ? null : (
                <Badge>
                  {Math.round((1 - suggestion.cosineDistance) * 100)}% similar
                </Badge>
              )}
            </div>
            <p className="max-w-3xl text-sm leading-6 text-[color:var(--ink-soft)]">
              {suggestion.matchReason}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-2">
        <section className="border-b border-black/6 p-5 sm:p-6 lg:border-r lg:border-b-0">
          <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
            Current
          </p>
          <div className="mt-4 space-y-4">
            <DiffText parts={diff.removed} tone="removed" />
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {suggestion.sourceHighlight.summary}
            </p>
          </div>
        </section>

        <section className="p-5 sm:p-6">
          <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
            Suggested
          </p>
          <div className="mt-4 space-y-4">
            <DiffText parts={diff.added} tone="added" />
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {draft.summary}
            </p>
          </div>
        </section>
      </div>

      <div className="grid gap-4 border-t border-black/6 bg-[color:var(--surface)] p-5 sm:p-6 lg:grid-cols-[1fr_auto]">
        <div className="space-y-2 text-sm leading-6 text-[color:var(--ink-soft)]">
          <p>
            Evidence refs: {currentEvidenceIds.size} current, {suggestedEvidenceIds.size} suggested
            {addedEvidenceCount ? `, ${addedEvidenceCount} new` : ""}.
          </p>
          {draft.tags.length ? (
            <div className="flex flex-wrap gap-2">
              {draft.tags.slice(0, 5).map((tag) => (
                <Badge key={`${suggestion.id}-${tag.dimension}-${tag.tag}`}>
                  {titleCase(tag.tag)}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 sm:min-w-[22rem]">
          <form action={acceptAction} className="space-y-3 [&_button]:w-full">
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <input type="hidden" name="workItemId" value={suggestion.workItemId} />
            <Textarea
              name="text"
              defaultValue={draft.text}
              className="min-h-24 bg-white"
              aria-label="Edit suggested highlight text before applying"
            />
            <SubmitButton pendingLabel="Applying update..." variant="primary">
              Accept update
            </SubmitButton>
          </form>

          <form action={dismissAction} className="[&_button]:w-full">
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <input type="hidden" name="workItemId" value={suggestion.workItemId} />
            <SubmitButton pendingLabel="Dismissing..." variant="secondary">
              Dismiss
            </SubmitButton>
          </form>
        </div>
      </div>
    </article>
  );
}
