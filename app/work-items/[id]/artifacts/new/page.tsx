import { generateArtifactAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { GenerationTracePanel } from "@/components/generation-trace-panel";
import { Badge } from "@/components/ui/badge";
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
  const usedClaimIds = Array.isArray(objectValue.usedClaimIds)
    ? objectValue.usedClaimIds.filter(
        (claimId: unknown): claimId is string => typeof claimId === "string",
      )
    : [];

  if (!artifactId) {
    return null;
  }

  return {
    artifactId,
    usedClaimIds,
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
  const approvedClaims = workItem.claims.filter(
    (claim) => claim.verificationStatus === "approved" && !claim.sensitivityFlag,
  );
  const artifactGenerationTraces = workItem.generationRuns.filter(
    (run) => run.kind === "artifact_generation",
  );
  const artifactTraceById = new Map(
    artifactGenerationTraces
      .map((trace) => {
        const resultRefs = readArtifactResultRefs(trace.resultRefs);

        if (!resultRefs?.artifactId) {
          return null;
        }

        return [resultRefs.artifactId, trace] as const;
      })
      .filter((entry): entry is readonly [string, (typeof artifactGenerationTraces)[number]] => Boolean(entry)),
  );
  const selectedArtifact =
    workItem.artifacts.find((artifact) => artifact.id === artifactId) ?? workItem.artifacts[0] ?? null;
  const selectedArtifactTrace = selectedArtifact
    ? artifactTraceById.get(selectedArtifact.id) ?? null
    : null;
  const selectedUsedClaimIds: string[] = selectedArtifactTrace
    ? readArtifactResultRefs(selectedArtifactTrace.resultRefs)?.usedClaimIds ?? []
    : [];
  const selectedUsedClaims = selectedUsedClaimIds
    .map((claimId: string) => workItem.claims.find((claim) => claim.id === claimId))
    .filter((claim): claim is (typeof workItem.claims)[number] => Boolean(claim));

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Artifact generator"
        title="Generate from approved claims only"
        description="Choose the artifact type, Target Angle, and tone. Workbase persists the output and keeps it constrained to approved, eligible claims."
      />

      <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <Card>
          <form action={generateArtifactAction}>
            <input type="hidden" name="workItemId" value={workItem.id} />
            <CardHeader>
              <CardTitle>Generator controls</CardTitle>
              <CardDescription>
                Targeting can reframe and prioritize claims, but it cannot invent work or metrics.
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
                  Target Angle
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
                Generate Artifact
              </SubmitButton>
            </CardContent>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Eligible approved claims</CardTitle>
            <CardDescription>
              Sensitive claims stay out. Visibility is checked at generation time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {approvedClaims.length ? (
              approvedClaims.map((claim) => (
                <div
                  key={claim.id}
                  className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="success">Approved</Badge>
                    <Badge>{claim.visibility.replace("_", " ")}</Badge>
                    <Badge>{claim.confidence}</Badge>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                    {claim.text}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No approved, non-sensitive claims are available yet.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {error === "no-eligible-claims" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              No approved, non-sensitive claims match the current visibility rules for that Artifact.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {error === "artifact-generation-failed" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not generate that Artifact. The generation trace panel below has the
              provider and validation details.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Artifact history</CardTitle>
          <CardDescription>
            Persisted outputs for this Work Item. Open any saved Artifact to inspect the content and the claims it used.
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
                  <Badge>{selectedUsedClaims.length} claims used</Badge>
                </div>

                <pre className="whitespace-pre-wrap rounded-[24px] bg-white p-5 font-sans text-sm leading-7 text-[color:var(--ink-strong)]">
                  {selectedArtifact.content}
                </pre>

                <div className="grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                      Claims used
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                      Workbase records the approved claim set used for each generated Artifact when trace data is available.
                    </p>
                  </div>

                  {selectedUsedClaims.length ? (
                    <div className="grid gap-3">
                      {selectedUsedClaims.map((claim) => (
                        <div
                          key={claim.id}
                          className="rounded-[22px] border border-black/8 bg-white p-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="success">Approved</Badge>
                            <Badge>{claim.visibility.replace("_", " ")}</Badge>
                            <Badge>{claim.confidence}</Badge>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                            {claim.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : selectedArtifactTrace ? (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      This Artifact has trace data, but Workbase could not resolve the recorded claims in the current workspace.
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      This Artifact was saved without a linked claim trace, so Workbase cannot show its claim lineage here.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                Generate an Artifact to start building a saved history for this Work Item.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <GenerationTracePanel
        traces={artifactGenerationTraces}
        title="Generation traces"
        description="Internal trace records for Artifact generation runs."
      />
    </WorkbaseFrame>
  );
}
