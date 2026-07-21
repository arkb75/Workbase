import { randomUUID } from "node:crypto";
import { generateArtifactAction } from "@/app/actions";
import { ArtifactHistoryPanel, type ArtifactHistoryEntry } from "@/components/artifacts/artifact-history-panel";
import { SubmitButton } from "@/components/forms/submit-button";
import { GenerationTracePanel } from "@/components/generation-trace-panel";
import { Badge } from "@/components/ui/badge";
import { CollapsibleCard } from "@/components/ui/collapsible-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import {
  nestArtifactEvidenceUnderHighlights,
  readArtifactEvidenceProvenance,
  readArtifactHighlightProvenance,
} from "@/src/lib/artifact-provenance";
import {
  artifactToneOptions,
  artifactTypeOptions,
  targetAngleOptions,
} from "@/src/lib/options";
import { loadWorkItemRouteData } from "@/src/lib/work-item-route";

export const dynamic = "force-dynamic";

function readArtifactResultRefs(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  const artifactId =
    typeof objectValue.artifactId === "string" && objectValue.artifactId.length
      ? objectValue.artifactId
      : null;
  const usedHighlightIds = Array.isArray(objectValue.usedHighlightIds)
    ? objectValue.usedHighlightIds.filter(
        (highlightId: unknown): highlightId is string => typeof highlightId === "string",
      )
    : Array.isArray(objectValue.usedClaimIds)
      ? objectValue.usedClaimIds.filter(
          (highlightId: unknown): highlightId is string => typeof highlightId === "string",
        )
      : [];
  const supportingEvidenceItemIds = Array.isArray(objectValue.supportingEvidenceItemIds)
    ? objectValue.supportingEvidenceItemIds.filter(
        (evidenceItemId: unknown): evidenceItemId is string => typeof evidenceItemId === "string",
      )
    : [];
  const fallbackUsed = objectValue.fallbackUsed === true;
  const fallbackNote =
    typeof objectValue.fallbackNote === "string" && objectValue.fallbackNote.length
      ? objectValue.fallbackNote
      : null;
  const unreviewedFallbackHighlights = Array.isArray(objectValue.unreviewedFallbackHighlights)
    ? objectValue.unreviewedFallbackHighlights.filter(
        (
          highlight,
        ): highlight is {
          id: string;
          text: string;
          summary: string;
          confidence: string;
          ownershipClarity: string;
        } =>
          Boolean(highlight) &&
          typeof highlight === "object" &&
          !Array.isArray(highlight) &&
          typeof (highlight as Record<string, unknown>).id === "string" &&
          typeof (highlight as Record<string, unknown>).text === "string" &&
          typeof (highlight as Record<string, unknown>).summary === "string" &&
          typeof (highlight as Record<string, unknown>).confidence === "string" &&
          typeof (highlight as Record<string, unknown>).ownershipClarity === "string",
      )
    : [];

  if (!artifactId) {
    return null;
  }

  return {
    artifactId,
    usedHighlightIds,
    supportingEvidenceItemIds,
    fallbackUsed,
    fallbackNote,
    unreviewedFallbackHighlights,
  };
}

export default async function ArtifactGeneratorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ artifactId?: string; error?: string }>;
}) {
  const { id } = await params;
  const { artifactId, error } = await searchParams;
  const user = await getDemoUser();
  const workItem = await loadWorkItemRouteData(() => getWorkItemForUser(user.id, id));
  const artifactFormIdempotencyKey = `artifact-form:${workItem.id}:${randomUUID()}`;
  const approvedHighlights = workItem.highlights.filter(
    (highlight) => highlight.verificationStatus === "approved" && !highlight.sensitivityFlag,
  );
  const artifactTraces = workItem.generationRuns.filter(
    (run) => run.kind === "artifact_retrieval" || run.kind === "artifact_generation",
  );
  const artifactTraceById = new Map(
    artifactTraces
      .map((trace) => {
        const resultRefs = readArtifactResultRefs(trace.resultRefs);

        if (!resultRefs?.artifactId) {
          return null;
        }

        return [resultRefs.artifactId, trace] as const;
      })
      .filter((entry): entry is readonly [string, (typeof artifactTraces)[number]] => Boolean(entry)),
  );
  const selectedArtifact =
    workItem.artifacts.find((artifact) => artifact.id === artifactId) ?? workItem.artifacts[0] ?? null;
  const artifactHistoryEntries: ArtifactHistoryEntry[] = workItem.artifacts.map((artifact) => {
    const trace = artifactTraceById.get(artifact.id) ?? null;
    const resultRefs = trace ? readArtifactResultRefs(trace.resultRefs) : null;
    const usedHighlightIds = resultRefs?.usedHighlightIds ?? [];
    const supportingEvidenceItemIds = resultRefs?.supportingEvidenceItemIds ?? [];
    const legacyUsedHighlights = usedHighlightIds
      .map((highlightId) => workItem.highlights.find((highlight) => highlight.id === highlightId))
      .filter((highlight): highlight is (typeof workItem.highlights)[number] => Boolean(highlight))
      .map((highlight) => ({
        id: highlight.id,
        text: highlight.text,
        summary: highlight.summary,
        visibility: highlight.visibility,
        confidence: highlight.confidence,
        evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
      }));
    const usedHighlightSnapshots = artifact.highlightProvenance.length
      ? readArtifactHighlightProvenance(artifact.highlightProvenance)
      : legacyUsedHighlights;
    const fallbackHighlights = resultRefs?.unreviewedFallbackHighlights ?? [];
    const legacySupportingEvidence = supportingEvidenceItemIds
      .map((evidenceItemId) => workItem.evidenceItems.find((item) => item.id === evidenceItemId))
      .filter((item): item is (typeof workItem.evidenceItems)[number] => Boolean(item))
      .map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        type: item.type,
        sourceLabel: item.source.label,
      }));
    const supportingEvidence = artifact.evidenceProvenance.length
      ? readArtifactEvidenceProvenance(artifact.evidenceProvenance)
      : legacySupportingEvidence;
    const usedHighlights = nestArtifactEvidenceUnderHighlights(
      usedHighlightSnapshots.map((highlight) =>
        highlight.evidenceItemIds.length
          ? highlight
          : {
              ...highlight,
              evidenceItemIds:
                workItem.highlights
                  .find((current) => current.id === highlight.id)
                  ?.evidence.map((entry) => entry.evidenceItemId) ?? [],
            },
      ),
      supportingEvidence,
    );

    return {
      id: artifact.id,
      workItemId: workItem.id,
      type: artifact.type,
      targetAngle: artifact.targetAngle,
      tone: artifact.tone,
      content: artifact.content,
      lifecycleStatus: artifact.lifecycleStatus,
      publicSafetyStatus: artifact.publicSafetyStatus,
      staleReason: artifact.staleReason,
      createdAt:
        artifact.createdAt instanceof Date ? artifact.createdAt.toISOString() : String(artifact.createdAt),
      highlightCount: usedHighlights.length || fallbackHighlights.length,
      evidenceCount: supportingEvidence.length,
      fallbackUsed: resultRefs?.fallbackUsed ?? false,
      fallbackNote: resultRefs?.fallbackNote ?? null,
      hasTrace: Boolean(trace),
      usedHighlights,
      fallbackHighlights,
    };
  });

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Artifact generator"
        title="Start with a freeform brief"
        description="Workbase maps your brief to a supported artifact, retrieves approved highlights, and opens any evidence-backed candidates for review in project chat before it writes."
      />

      <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <Card>
          <form action={generateArtifactAction}>
            <input type="hidden" name="workItemId" value={workItem.id} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={artifactFormIdempotencyKey}
            />
            <CardHeader>
              <CardTitle>Generator controls</CardTitle>
              <CardDescription>
                The brief leads; the structured controls provide a fallback when it is terse.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  What should Workbase write?
                </span>
                <Textarea
                  name="brief"
                  placeholder="Write three concise resume bullets emphasizing the architecture I owned and the measurable impact."
                  className="min-h-28"
                  maxLength={4000}
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Artifact type
                </span>
                <Select name="type" defaultValue="resume_bullets">
                  {artifactTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Target angle
                </span>
                <Select name="targetAngle" defaultValue="general">
                  {targetAngleOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Tone
                </span>
                <Select name="tone" defaultValue="concise">
                  {artifactToneOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <SubmitButton pendingLabel="Starting workflow...">
                Start artifact workflow
              </SubmitButton>
            </CardContent>
          </form>
        </Card>

        <CollapsibleCard
          title="Approved highlights available for retrieval"
          description="Sensitive highlights stay out. Visibility is checked at generation time."
          meta={<Badge tone="success">{approvedHighlights.length} approved</Badge>}
          bodyClassName="space-y-4"
        >
          {approvedHighlights.length ? (
            approvedHighlights.map((highlight) => (
              <div
                key={highlight.id}
                className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="success">Approved</Badge>
                  <Badge>{highlight.visibility.replace("_", " ")}</Badge>
                  <Badge>{highlight.confidence}</Badge>
                  {highlight.tags.slice(0, 3).map((tag) => (
                    <Badge key={`${highlight.id}-${tag.dimension}-${tag.tag}`}>
                      {tag.tag.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
                <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                  {highlight.text}
                </p>
                <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                  {highlight.summary}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              No approved, non-sensitive highlights are available yet.
              Research can propose evidence-backed candidates, but each one must be reviewed before
              it can support an artifact.
            </p>
          )}
        </CollapsibleCard>
      </section>

      {error === "no-eligible-claims" || error === "no-eligible-highlights" || error === "no-artifact-context" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase finished its bounded research passes without enough approved evidence to support that artifact.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {error === "artifact-generation-failed" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not generate that artifact. The generation trace panel below has the provider and validation details.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <ArtifactHistoryPanel
        entries={artifactHistoryEntries}
        initialSelectedArtifactId={selectedArtifact?.id ?? null}
      />

      <GenerationTracePanel
        traces={artifactTraces}
        title="Generation traces"
        description="Internal trace records for artifact retrieval and generation runs."
      />
    </WorkbaseFrame>
  );
}
