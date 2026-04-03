import { generateArtifactAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KeyValue } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getArtifactForUser, getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import {
  artifactToneOptions,
  artifactTypeOptions,
  targetAngleOptions,
} from "@/src/lib/options";

export const dynamic = "force-dynamic";

export default async function ArtifactGeneratorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ artifactId?: string }>;
}) {
  const { id } = await params;
  const { artifactId } = await searchParams;
  const user = await getDemoUser();
  const workItem = await getWorkItemForUser(user.id, id);
  const selectedArtifact = await getArtifactForUser(user.id, artifactId);
  const approvedClaims = workItem.claims.filter(
    (claim) => claim.verificationStatus === "approved" && !claim.sensitivityFlag,
  );

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

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Artifact output</CardTitle>
            <CardDescription>
              Latest generated content for this Work Item.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selectedArtifact ? (
              <div className="rounded-[28px] bg-[color:var(--panel-muted)] p-6">
                <div className="mb-4 flex flex-wrap gap-2">
                  <Badge tone="accent">{selectedArtifact.type.replace("_", " ")}</Badge>
                  <Badge>{selectedArtifact.targetAngle.replace("_", " ")}</Badge>
                  <Badge>{selectedArtifact.tone.replace("_", " ")}</Badge>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-[color:var(--ink-strong)]">
                  {selectedArtifact.content}
                </pre>
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                Generate an Artifact to preview the current approved-claim set.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Artifact history</CardTitle>
            <CardDescription>
              Persisted outputs for this Work Item.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <KeyValue label="Saved artifacts" value={workItem.artifacts.length} />
            {workItem.artifacts.length ? (
              workItem.artifacts.map((artifact) => (
                <a
                  key={artifact.id}
                  href={`?artifactId=${artifact.id}`}
                  className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4 text-sm text-[color:var(--ink-strong)] transition hover:border-[color:var(--accent)]"
                >
                  <div className="flex flex-wrap gap-2">
                    <Badge>{artifact.type.replace("_", " ")}</Badge>
                    <Badge>{artifact.targetAngle.replace("_", " ")}</Badge>
                  </div>
                  <p className="mt-3 line-clamp-3 leading-6 text-[color:var(--ink-soft)]">
                    {artifact.content}
                  </p>
                </a>
              ))
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No artifacts generated for this Work Item yet.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </WorkbaseFrame>
  );
}
