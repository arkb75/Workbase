import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import {
  upsertReviewableKnowledgeChange,
  upsertReviewableKnowledgeChangesInTransaction,
  type ReviewableKnowledgeChangeInput,
} from "@/src/services/knowledge-change-service";

const POLICY_VERSION = "knowledge-lifecycle-v2";

/**
 * Invalidates every live dependent of a stale-evidence batch inside the same
 * generation-fenced transaction that marks the Evidence stale. This is both
 * retry-safe and bounded: a committed transaction contains the complete
 * lifecycle transition, while a failed transaction leaves nothing for a
 * workflow retry to reconstruct.
 */
export async function invalidateStaleEvidenceDependentsInTransaction(input: {
  workItemId: string;
  evidenceItemIds: string[];
  reason: string;
  idempotencyScope: string;
  refreshRunId: string;
}, client: Prisma.TransactionClient) {
  if (!input.evidenceItemIds.length) {
    return { evidenceItemIds: [], projectFactIds: [], highlightIds: [], artifactIds: [] };
  }
  const staleEvidence = await client.evidenceItem.findMany({
    where: {
      id: { in: input.evidenceItemIds },
      workItemId: input.workItemId,
      lifecycleStatus: "stale",
    },
    select: { id: true },
  });
  const staleEvidenceIds = staleEvidence.map((evidence) => evidence.id);
  if (!staleEvidenceIds.length) {
    return { evidenceItemIds: [], projectFactIds: [], highlightIds: [], artifactIds: [] };
  }
  const [facts, highlights] = await Promise.all([
    client.projectFact.findMany({
      where: {
        workItemId: input.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
        evidence: { some: { evidenceItemId: { in: staleEvidenceIds } } },
      },
      select: {
        id: true,
        statement: true,
        lifecycleStatus: true,
        validatedThroughSha: true,
        validationHeads: true,
        evidence: {
          where: { evidenceItemId: { in: staleEvidenceIds } },
          select: { evidenceItemId: true },
        },
      },
    }),
    client.highlight.findMany({
      where: {
        workItemId: input.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
        evidence: { some: { evidenceItemId: { in: staleEvidenceIds } } },
      },
      select: {
        id: true,
        text: true,
        lifecycleStatus: true,
        validatedThroughSha: true,
        validationHeads: true,
        evidence: {
          where: { evidenceItemId: { in: staleEvidenceIds } },
          select: { evidenceItemId: true },
        },
      },
    }),
  ]);
  const factIds = facts.map((fact) => fact.id);
  const highlightIds = highlights.map((highlight) => highlight.id);
  if (factIds.length) {
    await client.projectFact.updateMany({
      where: {
        id: { in: factIds },
        workItemId: input.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
      },
      data: {
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        validationHeads: Prisma.JsonNull,
        lastValidatedAt: null,
      },
    });
  }
  if (highlightIds.length) {
    await client.highlight.updateMany({
      where: {
        id: { in: highlightIds },
        workItemId: input.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
      },
      data: {
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        validationHeads: Prisma.JsonNull,
        lastValidatedAt: null,
      },
    });
  }
  const artifacts = await client.artifact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: "active",
      OR: [
        { evidenceProvenance: { some: { evidenceItemId: { in: staleEvidenceIds } } } },
        ...(highlightIds.length
          ? [{ highlightProvenance: { some: { highlightId: { in: highlightIds } } } }]
          : []),
      ],
    },
    select: {
      id: true,
      content: true,
      lifecycleStatus: true,
      staleReason: true,
      evidenceProvenance: {
        where: { evidenceItemId: { in: staleEvidenceIds } },
        select: { evidenceItemId: true },
      },
      highlightProvenance: {
        where: { highlightId: { in: highlightIds.length ? highlightIds : [""] } },
        select: { highlightId: true },
      },
    },
  });
  const artifactIds = artifacts.map((artifact) => artifact.id);
  if (artifactIds.length) {
    await client.artifact.updateMany({
      where: {
        id: { in: artifactIds },
        workItemId: input.workItemId,
        lifecycleStatus: "active",
      },
      data: { lifecycleStatus: "stale", staleReason: input.reason },
    });
  }

  const changes: ReviewableKnowledgeChangeInput[] = [
    ...facts.map((fact) => ({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "project_fact" as const,
      action: "updated" as const,
      entityId: fact.id,
      beforeSnapshot: {
        id: fact.id,
        statement: fact.statement,
        lifecycleStatus: fact.lifecycleStatus,
        validatedThroughSha: fact.validatedThroughSha,
        validationHeads: fact.validationHeads,
      },
      afterSnapshot: {
        id: fact.id,
        statement: fact.statement,
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        validationHeads: null,
      },
      reason: input.reason,
      provenance: {
        invalidatedEvidenceItemIds: fact.evidence.map((entry) => entry.evidenceItemId),
      },
      policyVersion: POLICY_VERSION,
      idempotencyKey: `${input.idempotencyScope}:dependency-invalidation:project_fact:${fact.id}`,
    })),
    ...highlights.map((highlight) => ({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "highlight" as const,
      action: "updated" as const,
      entityId: highlight.id,
      beforeSnapshot: {
        id: highlight.id,
        text: highlight.text,
        lifecycleStatus: highlight.lifecycleStatus,
        validatedThroughSha: highlight.validatedThroughSha,
        validationHeads: highlight.validationHeads,
      },
      afterSnapshot: {
        id: highlight.id,
        text: highlight.text,
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        validationHeads: null,
      },
      reason: input.reason,
      provenance: {
        invalidatedEvidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
      },
      policyVersion: POLICY_VERSION,
      idempotencyKey: `${input.idempotencyScope}:dependency-invalidation:highlight:${highlight.id}`,
    })),
    ...artifacts.map((artifact) => ({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "artifact" as const,
      action: "updated" as const,
      entityId: artifact.id,
      beforeSnapshot: {
        id: artifact.id,
        content: artifact.content,
        lifecycleStatus: artifact.lifecycleStatus,
        staleReason: artifact.staleReason,
      },
      afterSnapshot: {
        id: artifact.id,
        content: artifact.content,
        lifecycleStatus: "stale",
        staleReason: input.reason,
      },
      reason: input.reason,
      provenance: {
        invalidatedEvidenceItemIds: artifact.evidenceProvenance.map((entry) => entry.evidenceItemId),
        invalidatedHighlightIds: artifact.highlightProvenance.map((entry) => entry.highlightId),
      },
      policyVersion: POLICY_VERSION,
      idempotencyKey: `${input.idempotencyScope}:dependency-invalidation:artifact:${artifact.id}`,
    })),
  ];
  await upsertReviewableKnowledgeChangesInTransaction(changes, client);
  return { evidenceItemIds: staleEvidenceIds, projectFactIds: factIds, highlightIds, artifactIds };
}

async function recordInvalidation(input: {
  workItemId: string;
  refreshRunId?: string | null;
  entityKind: "highlight" | "project_fact" | "artifact";
  entityId: string;
  relation: { highlightId: string } | { projectFactId: string } | { artifactId: string };
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  reason: string;
  provenance: unknown;
  idempotencyScope: string;
}) {
  const idempotencyKey = [
    input.idempotencyScope,
    "dependency-invalidation",
    input.entityKind,
    input.entityId,
  ].join(":");
  await upsertReviewableKnowledgeChange({
    workItemId: input.workItemId,
    refreshRunId: input.refreshRunId,
    entityKind: input.entityKind,
    action: "updated",
    entityId: input.entityId,
    beforeSnapshot: input.beforeSnapshot,
    afterSnapshot: input.afterSnapshot,
    reason: input.reason,
    provenance: input.provenance,
    policyVersion: POLICY_VERSION,
    idempotencyKey,
  });
}

/**
 * Invalidates every durable assertion and artifact that relies on an Evidence
 * revision which has changed state. This deliberately clears repository-head
 * validation: an assertion cannot stay current merely because its text did not
 * change when the immutable excerpt supporting it did.
 */
export async function invalidateEvidenceDependents(input: {
  workItemId: string;
  evidenceItemId: string;
  reason: string;
  idempotencyScope: string;
  refreshRunId?: string | null;
  mutationFence?: <T>(
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
}) {
  const mutate = input.mutationFence ??
    (<T>(operation: (client: Prisma.TransactionClient) => Promise<T>) =>
      operation(prisma as unknown as Prisma.TransactionClient));
  const [facts, highlights] = await Promise.all([
    prisma.projectFact.findMany({
      where: {
        workItemId: input.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
        evidence: { some: { evidenceItemId: input.evidenceItemId } },
      },
      select: {
        id: true,
        statement: true,
        lifecycleStatus: true,
        validatedThroughSha: true,
        validationHeads: true,
      },
    }),
    prisma.highlight.findMany({
      where: {
        workItemId: input.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
        evidence: { some: { evidenceItemId: input.evidenceItemId } },
      },
      select: {
        id: true,
        text: true,
        lifecycleStatus: true,
        validatedThroughSha: true,
        validationHeads: true,
      },
    }),
  ]);

  for (const fact of facts) {
    await mutate((client) =>
      client.projectFact.update({
        where: { id: fact.id },
        data: {
          lifecycleStatus: "needs_validation",
          validatedThroughSha: null,
          validationHeads: Prisma.JsonNull,
          lastValidatedAt: null,
        },
      })
    );
    await recordInvalidation({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "project_fact",
      entityId: fact.id,
      relation: { projectFactId: fact.id },
      beforeSnapshot: {
        id: fact.id,
        statement: fact.statement,
        lifecycleStatus: fact.lifecycleStatus,
        validatedThroughSha: fact.validatedThroughSha,
        validationHeads: fact.validationHeads,
      },
      afterSnapshot: {
        id: fact.id,
        statement: fact.statement,
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        validationHeads: null,
      },
      reason: input.reason,
      provenance: { invalidatedEvidenceItemId: input.evidenceItemId },
      idempotencyScope: input.idempotencyScope,
    });
  }

  for (const highlight of highlights) {
    await mutate((client) =>
      client.highlight.update({
        where: { id: highlight.id },
        data: {
          lifecycleStatus: "needs_validation",
          validatedThroughSha: null,
          validationHeads: Prisma.JsonNull,
          lastValidatedAt: null,
        },
      })
    );
    await recordInvalidation({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "highlight",
      entityId: highlight.id,
      relation: { highlightId: highlight.id },
      beforeSnapshot: {
        id: highlight.id,
        text: highlight.text,
        lifecycleStatus: highlight.lifecycleStatus,
        validatedThroughSha: highlight.validatedThroughSha,
        validationHeads: highlight.validationHeads,
      },
      afterSnapshot: {
        id: highlight.id,
        text: highlight.text,
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        validationHeads: null,
      },
      reason: input.reason,
      provenance: { invalidatedEvidenceItemId: input.evidenceItemId },
      idempotencyScope: input.idempotencyScope,
    });
  }

  const highlightIds = highlights.map((highlight) => highlight.id);
  const artifacts = await prisma.artifact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: "active",
      OR: [
        { evidenceProvenance: { some: { evidenceItemId: input.evidenceItemId } } },
        ...(highlightIds.length
          ? [{ highlightProvenance: { some: { highlightId: { in: highlightIds } } } }]
          : []),
      ],
    },
    select: { id: true, content: true, lifecycleStatus: true, staleReason: true },
  });
  for (const artifact of artifacts) {
    await mutate((client) =>
      client.artifact.update({
        where: { id: artifact.id },
        data: { lifecycleStatus: "stale", staleReason: input.reason },
      })
    );
    await recordInvalidation({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "artifact",
      entityId: artifact.id,
      relation: { artifactId: artifact.id },
      beforeSnapshot: {
        id: artifact.id,
        content: artifact.content,
        lifecycleStatus: artifact.lifecycleStatus,
        staleReason: artifact.staleReason,
      },
      afterSnapshot: {
        id: artifact.id,
        content: artifact.content,
        lifecycleStatus: "stale",
        staleReason: input.reason,
      },
      reason: input.reason,
      provenance: {
        invalidatedEvidenceItemId: input.evidenceItemId,
        invalidatedHighlightIds: highlightIds,
      },
      idempotencyScope: input.idempotencyScope,
    });
  }

  return {
    projectFactIds: facts.map((fact) => fact.id),
    highlightIds,
    artifactIds: artifacts.map((artifact) => artifact.id),
  };
}

export async function invalidateHighlightDependents(input: {
  workItemId: string;
  highlightId: string;
  reason: string;
  idempotencyScope: string;
  refreshRunId?: string | null;
}) {
  const artifacts = await prisma.artifact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: "active",
      highlightProvenance: { some: { highlightId: input.highlightId } },
    },
    select: { id: true, content: true, lifecycleStatus: true, staleReason: true },
  });
  for (const artifact of artifacts) {
    await prisma.artifact.update({
      where: { id: artifact.id },
      data: { lifecycleStatus: "stale", staleReason: input.reason },
    });
    await recordInvalidation({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "artifact",
      entityId: artifact.id,
      relation: { artifactId: artifact.id },
      beforeSnapshot: {
        id: artifact.id,
        content: artifact.content,
        lifecycleStatus: artifact.lifecycleStatus,
        staleReason: artifact.staleReason,
      },
      afterSnapshot: {
        id: artifact.id,
        content: artifact.content,
        lifecycleStatus: "stale",
        staleReason: input.reason,
      },
      reason: input.reason,
      provenance: { invalidatedHighlightId: input.highlightId },
      idempotencyScope: input.idempotencyScope,
    });
  }
  return artifacts.map((artifact) => artifact.id);
}
