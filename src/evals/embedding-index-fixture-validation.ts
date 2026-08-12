import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import type { EmbeddingRequiredSources } from "@/src/evals/embedding-index-query-evaluation";

export type EmbeddingEvaluationFixtureSources = {
  workItemId?: string;
  queries: Array<{
    required: EmbeddingRequiredSources;
  }>;
};

function requiredIdsForKind(
  fixture: EmbeddingEvaluationFixtureSources,
  kind: keyof EmbeddingRequiredSources,
) {
  return Array.from(new Set(fixture.queries.flatMap((query) =>
    query.required[kind]?.flatMap((entry) =>
      Array.isArray(entry) ? entry : [entry]
    ) ?? []
  )));
}

export async function validateEmbeddingFixtureSources(
  fixture: EmbeddingEvaluationFixtureSources,
) {
  const highlightIds = requiredIdsForKind(fixture, "highlights");
  const projectFactIds = requiredIdsForKind(fixture, "projectFacts");
  const evidenceIds = requiredIdsForKind(fixture, "evidence");
  const artifactIds = requiredIdsForKind(fixture, "artifacts");
  const [highlights, projectFacts, evidence, artifacts] = await Promise.all([
    highlightIds.length
      ? prisma.$queryRaw<Array<{
          id: string;
          workItemId: string;
          verificationStatus: string;
          lifecycleStatus: string;
        }>>(Prisma.sql`
          SELECT "id", "workItemId", "verificationStatus"::text, "lifecycleStatus"::text
          FROM "Claim"
          WHERE "id" IN (${Prisma.join(highlightIds)})
        `)
      : Promise.resolve([]),
    projectFactIds.length
      ? prisma.$queryRaw<Array<{
          id: string;
          workItemId: string;
          status: string;
          lifecycleStatus: string;
        }>>(Prisma.sql`
          SELECT "id", "workItemId", "status"::text, "lifecycleStatus"::text
          FROM "ProjectFact"
          WHERE "id" IN (${Prisma.join(projectFactIds)})
        `)
      : Promise.resolve([]),
    evidenceIds.length
      ? prisma.$queryRaw<Array<{
          id: string;
          workItemId: string;
          included: boolean;
          lifecycleStatus: string;
        }>>(Prisma.sql`
          SELECT "id", "workItemId", "included", "lifecycleStatus"::text
          FROM "EvidenceItem"
          WHERE "id" IN (${Prisma.join(evidenceIds)})
        `)
      : Promise.resolve([]),
    artifactIds.length
      ? prisma.$queryRaw<Array<{
          id: string;
          workItemId: string | null;
          lifecycleStatus: string;
        }>>(Prisma.sql`
          SELECT "id", "workItemId", "lifecycleStatus"::text
          FROM "Artifact"
          WHERE "id" IN (${Prisma.join(artifactIds)})
        `)
      : Promise.resolve([]),
  ]);
  const expectedIds = [
    ...highlightIds,
    ...projectFactIds,
    ...evidenceIds,
    ...artifactIds,
  ];
  const foundRows = [...highlights, ...projectFacts, ...evidence, ...artifacts];
  const foundIds = new Set(foundRows.map((row) => row.id));
  const missingIds = expectedIds.filter((id) => !foundIds.has(id));
  if (missingIds.length) {
    throw new Error(
      `Embedding fixture references missing required IDs: ${missingIds.join(", ")}.`,
    );
  }

  const ineligibleIds = [
    ...highlights
      .filter((row) =>
        row.verificationStatus !== "approved" || row.lifecycleStatus !== "active"
      )
      .map((row) => row.id),
    ...projectFacts
      .filter((row) => row.status !== "approved" || row.lifecycleStatus !== "active")
      .map((row) => row.id),
    ...evidence
      .filter((row) => !row.included || row.lifecycleStatus !== "active")
      .map((row) => row.id),
    ...artifacts
      .filter((row) => row.lifecycleStatus !== "active")
      .map((row) => row.id),
  ];
  if (ineligibleIds.length) {
    throw new Error(
      `Embedding fixture references non-retrievable required IDs: ${ineligibleIds.join(", ")}.`,
    );
  }

  const workItemIds = new Set(
    foundRows.flatMap((row) => row.workItemId ? [row.workItemId] : []),
  );
  if (
    foundRows.some((row) => !row.workItemId) ||
    workItemIds.size !== 1 ||
    (fixture.workItemId && !workItemIds.has(fixture.workItemId))
  ) {
    throw new Error(
      "Every required fixture source must belong to the fixture's one Work Item.",
    );
  }
  const resolvedWorkItemId = fixture.workItemId ?? Array.from(workItemIds)[0];
  if (!resolvedWorkItemId) {
    throw new Error("Embedding fixture did not resolve a Work Item.");
  }
  return resolvedWorkItemId;
}
