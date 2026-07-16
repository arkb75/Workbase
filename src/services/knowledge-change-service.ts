import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";

type EntityKind = "evidence" | "highlight" | "project_fact" | "artifact";
type ChangeAction = "created" | "updated" | "revalidated" | "retired" | "quarantined";

export type AutoResolvedKnowledgeChangeInput = {
  workItemId: string;
  refreshRunId?: string | null;
  entityKind: EntityKind;
  action: ChangeAction;
  entityId: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  reason: string;
  provenance?: unknown;
  downstreamImpact?: unknown;
  policyVersion: string;
  modelId?: string | null;
  idempotencyKey: string;
};

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function relationFor(kind: EntityKind, entityId: string) {
  return kind === "evidence"
    ? { evidenceItemId: entityId }
    : kind === "highlight"
      ? { highlightId: entityId }
      : kind === "project_fact"
        ? { projectFactId: entityId }
        : { artifactId: entityId };
}

/**
 * Persists one review card per lifecycle transition and retires older pending
 * cards for the same entity. An already persisted idempotency key is returned
 * unchanged, even after review, so workflow retries never reopen a decision.
 */
export async function upsertReviewableKnowledgeChange(input: {
  workItemId: string;
  refreshRunId?: string | null;
  entityKind: EntityKind;
  action: ChangeAction;
  entityId: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  reason: string;
  provenance?: unknown;
  downstreamImpact?: unknown;
  policyVersion: string;
  modelId?: string | null;
  idempotencyKey: string;
}) {
  const relation = relationFor(input.entityKind, input.entityId);
  const existing = await prisma.knowledgeChange.findUnique({
    where: {
      workItemId_idempotencyKey: {
        workItemId: input.workItemId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) return existing;

  const change = await prisma.knowledgeChange.upsert({
    where: {
      workItemId_idempotencyKey: {
        workItemId: input.workItemId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    create: {
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId ?? undefined,
      entityKind: input.entityKind,
      action: input.action,
      ...relation,
      beforeSnapshot: input.beforeSnapshot === undefined ? undefined : toInputJson(input.beforeSnapshot),
      afterSnapshot: input.afterSnapshot === undefined ? undefined : toInputJson(input.afterSnapshot),
      reason: input.reason,
      provenance: input.provenance === undefined ? undefined : toInputJson(input.provenance),
      downstreamImpact: input.downstreamImpact === undefined ? undefined : toInputJson(input.downstreamImpact),
      policyVersion: input.policyVersion,
      modelId: input.modelId ?? undefined,
      idempotencyKey: input.idempotencyKey,
    },
    update: {},
  });

  if (change?.id) {
    const before = input.beforeSnapshot && typeof input.beforeSnapshot === "object" && !Array.isArray(input.beforeSnapshot)
      ? input.beforeSnapshot as Record<string, unknown>
      : null;
    const predecessorId = typeof before?.id === "string" && before.id !== input.entityId ? before.id : null;
    await prisma.knowledgeChange.updateMany({
      where: {
        workItemId: input.workItemId,
        decision: "pending",
        id: { not: change.id },
        ...relation,
      },
      data: {
        decision: "retired",
        reviewedAt: new Date(),
        feedback: "This review card was superseded by a newer lifecycle transition for the same item.",
      },
    });
    if (predecessorId) {
      await prisma.knowledgeChange.updateMany({
        where: {
          workItemId: input.workItemId,
          decision: "pending",
          ...relationFor(input.entityKind, predecessorId),
        },
        data: {
          decision: "retired",
          reviewedAt: new Date(),
          feedback: "This review card was superseded by a newer immutable successor.",
        },
      });
    }
  }
  return change;
}

/**
 * Records content-identical lifecycle maintenance without adding it to the
 * user's review queue. These rows remain a per-entity audit trail, but are
 * born resolved because advancing an unchanged Git blob to a newer repository
 * head does not change the knowledge the user previously reviewed.
 *
 * `createMany(..., skipDuplicates)` turns an arbitrary number of automatic
 * revalidations into one retry-safe write. Callers use a content-addressed
 * idempotency key, so a workflow retry cannot manufacture review noise.
 */
export async function recordAutoResolvedKnowledgeChanges(
  inputs: readonly AutoResolvedKnowledgeChangeInput[],
) {
  if (!inputs.length) return { count: 0 };
  const reviewedAt = new Date();
  return prisma.knowledgeChange.createMany({
    data: inputs.map((input) => ({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId ?? null,
      entityKind: input.entityKind,
      action: input.action,
      decision: "kept" as const,
      ...relationFor(input.entityKind, input.entityId),
      ...(input.beforeSnapshot === undefined
        ? {}
        : { beforeSnapshot: toInputJson(input.beforeSnapshot) }),
      ...(input.afterSnapshot === undefined
        ? {}
        : { afterSnapshot: toInputJson(input.afterSnapshot) }),
      reason: input.reason,
      ...(input.provenance === undefined
        ? {}
        : { provenance: toInputJson(input.provenance) }),
      ...(input.downstreamImpact === undefined
        ? {}
        : { downstreamImpact: toInputJson(input.downstreamImpact) }),
      policyVersion: input.policyVersion,
      modelId: input.modelId ?? null,
      idempotencyKey: input.idempotencyKey,
      reviewedAt,
      feedback: "Automatically resolved because immutable repository content was unchanged.",
    })),
    skipDuplicates: true,
  });
}

export function entityRelationId(change: {
  evidenceItemId?: string | null;
  highlightId?: string | null;
  projectFactId?: string | null;
  artifactId?: string | null;
}) {
  return change.evidenceItemId ?? change.highlightId ?? change.projectFactId ?? change.artifactId ?? null;
}

export function reviewSnapshotMatchesEntity(input: {
  entityId: string;
  afterSnapshot: unknown;
  entity: Record<string, unknown> | null;
}) {
  if (!input.entity) return false;
  const after = input.afterSnapshot && typeof input.afterSnapshot === "object" && !Array.isArray(input.afterSnapshot)
    ? input.afterSnapshot as Record<string, unknown>
    : null;
  if (!after) return true;
  if (typeof after.id === "string" && after.id !== input.entityId) return false;
  for (const key of ["lifecycleStatus", "validatedThroughSha", "status", "verificationStatus", "text", "statement", "content"] as const) {
    if (after[key] !== undefined && after[key] !== input.entity[key]) return false;
  }
  return true;
}
