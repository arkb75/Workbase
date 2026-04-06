import { generateArtifactAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { GenerationTracePanel } from "@/components/generation-trace-panel";
import { Badge } from "@/components/ui/badge";
import { CollapsibleCard } from "@/components/ui/collapsible-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KeyValue } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import {
  artifactToneOptions,
  artifactTypeOptions,
  targetAngleOptions,
} from "@/src/lib/options";
import { cn, formatDateTime } from "@/src/lib/utils";

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

  if (!artifactId) {
    return null;
  }

  return {
    artifactId,
    usedHighlightIds,
    supportingEvidenceItemIds,
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
  const workItem = await getWorkItemForUser(user.id, id);
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
  const selectedArtifactTrace = selectedArtifact
    ? artifactTraceById.get(selectedArtifact.id) ?? null
    : null;
  const selectedUsedHighlightIds: string[] = selectedArtifactTrace
    ? readArtifactResultRefs(selectedArtifactTrace.resultRefs)?.usedHighlightIds ?? []
    : [];
  const selectedSupportingEvidenceItemIds: string[] = selectedArtifactTrace
    ? readArtifactResultRefs(selectedArtifactTrace.resultRefs)?.supportingEvidenceItemIds ?? []
    : [];
  const selectedUsedHighlights = selectedUsedHighlightIds
    .map((highlightId) => workItem.highlights.find((highlight) => highlight.id === highlightId))
    .filter((highlight): highlight is (typeof workItem.highlights)[number] => Boolean(highlight));
  const selectedSupportingEvidence = selectedSupportingEvidenceItemIds
    .map((evidenceItemId) =>
      workItem.evidenceItems.find((item) => item.id === evidenceItemId),
    )
    .filter((item): item is (typeof workItem.evidenceItems)[number] => Boolean(item));

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Artifact generator"
        title="Generate from approved highlights"
        description="Choose the artifact type, target angle, and tone. Workbase retrieves the best approved highlights first, then adds bounded supporting evidence when needed."
      />

      <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <Card>
          <form action={generateArtifactAction}>
            <input type="hidden" name="workItemId" value={workItem.id} />
            <CardHeader>
              <CardTitle>Generator controls</CardTitle>
              <CardDescription>
                Targeting can reprioritize highlights, but it cannot invent work, metrics, or scope.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
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

              <SubmitButton pendingLabel="Generating artifact...">
                Generate artifact
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
            </p>
          )}
        </CollapsibleCard>
      </section>

      {error === "no-eligible-claims" || error === "no-eligible-highlights" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              No approved, non-sensitive highlights match the current visibility rules for that artifact.
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

      <Card>
        <CardHeader>
          <CardTitle>Artifact history</CardTitle>
          <CardDescription>
            Persisted outputs for this Work Item. Open any saved artifact to inspect the content, the highlights it used, and the supporting evidence that shaped it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[0.72fr_1.28fr]">
          <div className="grid gap-4">
            <KeyValue label="Saved artifacts" value={workItem.artifacts.length} />
            {workItem.artifacts.length ? (
              workItem.artifacts.map((artifact) => {
                const isSelected = selectedArtifact?.id === artifact.id;

                return (
                  <a
                    key={artifact.id}
                    href={`?artifactId=${artifact.id}`}
                    className={cn(
                      "rounded-[24px] border p-4 text-sm transition",
                      isSelected
                        ? "border-[color:var(--accent)] bg-[color:var(--panel-muted)] shadow-[0_16px_32px_rgba(19,120,111,0.08)]"
                        : "border-black/8 bg-white hover:border-[color:var(--accent)]",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={isSelected ? "accent" : "neutral"}>
                        {artifact.type.replace("_", " ")}
                      </Badge>
                      <Badge>{artifact.targetAngle.replace("_", " ")}</Badge>
                      <Badge>{artifact.tone.replace("_", " ")}</Badge>
                    </div>
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      {formatDateTime(artifact.createdAt)}
                    </p>
                    <p className="mt-3 line-clamp-4 leading-6 text-[color:var(--ink-soft)]">
                      {artifact.content}
                    </p>
                  </a>
                );
              })
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No artifacts generated for this Work Item yet.
              </p>
            )}
          </div>

          <div className="min-h-[360px] rounded-[28px] border border-black/8 bg-[color:var(--panel-muted)] p-6">
            {selectedArtifact ? (
              <div className="grid gap-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{selectedArtifact.type.replace("_", " ")}</Badge>
                  <Badge>{selectedArtifact.targetAngle.replace("_", " ")}</Badge>
                  <Badge>{selectedArtifact.tone.replace("_", " ")}</Badge>
                  <Badge>{formatDateTime(selectedArtifact.createdAt)}</Badge>
                  <Badge>{selectedUsedHighlights.length} highlights used</Badge>
                  <Badge>{selectedSupportingEvidence.length} evidence refs</Badge>
                </div>

                <pre className="whitespace-pre-wrap rounded-[24px] bg-white p-5 font-sans text-sm leading-7 text-[color:var(--ink-strong)]">
                  {selectedArtifact.content}
                </pre>

                <div className="grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      Highlights used
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                      Workbase records the approved highlight set used for each generated artifact when trace data is available.
                    </p>
                  </div>

                  {selectedUsedHighlights.length ? (
                    <div className="grid gap-3">
                      {selectedUsedHighlights.map((highlight) => (
                        <div
                          key={highlight.id}
                          className="rounded-[22px] border border-black/8 bg-white p-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="success">Approved</Badge>
                            <Badge>{highlight.visibility.replace("_", " ")}</Badge>
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
                  ) : selectedArtifactTrace ? (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      This artifact has trace data, but Workbase could not resolve the recorded highlights in the current workspace.
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      This artifact was saved without a linked highlight trace, so Workbase cannot show its highlight lineage here.
                    </p>
                  )}
                </div>

                <div className="grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      Supporting evidence
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                      Supporting evidence expands context around the selected approved highlights without introducing brand-new unreviewed accomplishments.
                    </p>
                  </div>

                  {selectedSupportingEvidence.length ? (
                    <div className="grid gap-3">
                      {selectedSupportingEvidence.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-[22px] border border-black/8 bg-white p-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{item.type.replace(/_/g, " ")}</Badge>
                            <Badge>{item.source.label}</Badge>
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
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                Generate an artifact to start building a saved history for this Work Item.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <GenerationTracePanel
        traces={artifactTraces}
        title="Generation traces"
        description="Internal trace records for artifact retrieval and generation runs."
      />
    </WorkbaseFrame>
  );
}
