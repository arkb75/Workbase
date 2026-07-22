import { randomUUID } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";

type EntityKind = "evidence" | "highlight" | "project_fact" | "artifact";
type ChangeAction = "created" | "updated" | "revalidated" | "retired" | "quarantined";

export type ReviewableKnowledgeChangeInput = {
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

async function runSerializableTransaction<T>(
  task: (client: Prisma.TransactionClient) => Promise<T>,
) {
  const maximumAttempts = 8;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(task, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10_000,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === "P2034" && attempt < maximumAttempts - 1) {
        // Immediate retries from several repository excerpts can repeatedly
        // collide on Neon/PostgreSQL's serializable review indexes. A short
        // capped exponential backoff preserves the transaction's correctness
        // while letting a competing transition commit before the next retry.
        const baseDelayMs = Math.min(250, 10 * (2 ** attempt));
        const delayMs = baseDelayMs + Math.floor(Math.random() * Math.max(1, baseDelayMs / 2));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Serializable transaction retry budget exhausted.");
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
  return runSerializableTransaction((client) =>
    upsertReviewableKnowledgeChangeOnce(input, client)
  );
}

/**
 * Persists a homogeneous review batch with a constant number of database
 * round trips. Explicit IDs let retries distinguish rows inserted by this
 * transaction from rows that already existed under the same idempotency key,
 * so replaying an old workflow cannot retire a newer review card.
 */
export async function upsertReviewableKnowledgeChangesInTransaction(
  inputs: readonly ReviewableKnowledgeChangeInput[],
  client: Prisma.TransactionClient,
) {
  if (!inputs.length) return [];
  const workItemIds = new Set(inputs.map((input) => input.workItemId));
  if (workItemIds.size !== 1) {
    throw new Error("A reviewable knowledge-change batch must belong to one Work Item.");
  }
  const workItemId = inputs[0]!.workItemId;
  const requested = inputs.map((input) => ({ input, id: randomUUID() }));
  await client.knowledgeChange.createMany({
    data: requested.map(({ input, id }) => ({
      id,
      workItemId,
      refreshRunId: input.refreshRunId ?? null,
      entityKind: input.entityKind,
      action: input.action,
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
    })),
    skipDuplicates: true,
  });
  const persisted = await client.knowledgeChange.findMany({
    where: {
      workItemId,
      idempotencyKey: { in: inputs.map((input) => input.idempotencyKey) },
    },
    select: { id: true, idempotencyKey: true },
  });
  const requestedIds = new Set<string>(requested.map((entry) => entry.id));
  const newlyInserted = persisted.filter((change) => requestedIds.has(change.id));
  if (newlyInserted.length) {
    const newIds = new Set<string>(newlyInserted.map((change) => change.id));
    const insertedInputs = requested
      .filter((entry) => newIds.has(entry.id))
      .map((entry) => entry.input);
    const reviewedAt = new Date();
    for (const entityKind of ["evidence", "highlight", "project_fact", "artifact"] as const) {
      const entityIds = Array.from(new Set(
        insertedInputs
          .filter((input) => input.entityKind === entityKind)
          .map((input) => input.entityId),
      ));
      if (!entityIds.length) continue;
      await client.knowledgeChange.updateMany({
        where: {
          workItemId,
          decision: "pending",
          id: { notIn: Array.from(newIds) },
          ...(entityKind === "evidence"
            ? { evidenceItemId: { in: entityIds } }
            : entityKind === "highlight"
              ? { highlightId: { in: entityIds } }
              : entityKind === "project_fact"
                ? { projectFactId: { in: entityIds } }
                : { artifactId: { in: entityIds } }),
        },
        data: {
          decision: "retired",
          reviewedAt,
          feedback: "This review card was superseded by a newer lifecycle transition for the same item.",
        },
      });
      const predecessorIds = Array.from(new Set(insertedInputs.flatMap((input) => {
        if (input.entityKind !== entityKind) return [];
        const before = input.beforeSnapshot &&
          typeof input.beforeSnapshot === "object" &&
          !Array.isArray(input.beforeSnapshot)
          ? input.beforeSnapshot as Record<string, unknown>
          : null;
        const predecessorId = typeof before?.id === "string" ? before.id : null;
        return predecessorId && predecessorId !== input.entityId ? [predecessorId] : [];
      })));
      if (!predecessorIds.length) continue;
      await client.knowledgeChange.updateMany({
        where: {
          workItemId,
          decision: "pending",
          ...(entityKind === "evidence"
            ? { evidenceItemId: { in: predecessorIds } }
            : entityKind === "highlight"
              ? { highlightId: { in: predecessorIds } }
              : entityKind === "project_fact"
                ? { projectFactId: { in: predecessorIds } }
                : { artifactId: { in: predecessorIds } }),
        },
        data: {
          decision: "retired",
          reviewedAt,
          feedback: "This review card was superseded by a newer immutable successor.",
        },
      });
    }
  }
  const byKey = new Map(persisted.map((change) => [change.idempotencyKey, change]));
  return inputs.flatMap((input) => {
    const change = byKey.get(input.idempotencyKey);
    return change ? [change] : [];
  });
}

async function upsertReviewableKnowledgeChangeOnce(
  input: Parameters<typeof upsertReviewableKnowledgeChange>[0],
  client: Prisma.TransactionClient,
) {
  const relation = relationFor(input.entityKind, input.entityId);
  const existing = await client.knowledgeChange.findUnique({
    where: {
      workItemId_idempotencyKey: {
        workItemId: input.workItemId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) return existing;

  const change = await client.knowledgeChange.upsert({
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
    const reviewedAt = new Date();
    await client.knowledgeChange.updateMany({
      where: {
        workItemId: input.workItemId,
        decision: "pending",
        id: { not: change.id },
        ...relation,
      },
      data: {
        decision: "retired",
        reviewedAt,
        feedback: "This review card was superseded by a newer lifecycle transition for the same item.",
      },
    });
    if (predecessorId) {
      await client.knowledgeChange.updateMany({
        where: {
          workItemId: input.workItemId,
          decision: "pending",
          ...relationFor(input.entityKind, predecessorId),
        },
        data: {
          decision: "retired",
          reviewedAt,
          feedback: "This review card was superseded by a newer immutable successor.",
        },
      });
    }
  }
  return change;
}

export function upsertReviewableKnowledgeChangeInTransaction(
  input: Parameters<typeof upsertReviewableKnowledgeChange>[0],
  client: Prisma.TransactionClient,
) {
  return upsertReviewableKnowledgeChangeOnce(input, client);
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
  return runSerializableTransaction((client) =>
    recordAutoResolvedKnowledgeChangesOnce(inputs, client)
  );
}

async function recordAutoResolvedKnowledgeChangesOnce(
  inputs: readonly AutoResolvedKnowledgeChangeInput[],
  client: Prisma.TransactionClient,
) {
  const reviewedAt = new Date();
  const idsByKind = new Map<EntityKind, Set<string>>();
  for (const input of inputs) {
    const ids = idsByKind.get(input.entityKind) ?? new Set<string>();
    ids.add(input.entityId);
    idsByKind.set(input.entityKind, ids);
  }
  const workItemIds = Array.from(new Set(inputs.map((input) => input.workItemId)));
  const [evidenceItems, highlights, projectFacts, artifacts] = await Promise.all([
    idsByKind.get("evidence")?.size
      ? client.evidenceItem.findMany({
          where: { id: { in: Array.from(idsByKind.get("evidence")!) } },
          select: { id: true, lifecycleStatus: true, validatedThroughSha: true, content: true },
        })
      : Promise.resolve([]),
    idsByKind.get("highlight")?.size
      ? client.highlight.findMany({
          where: { id: { in: Array.from(idsByKind.get("highlight")!) } },
          select: { id: true, lifecycleStatus: true, validatedThroughSha: true, text: true },
        })
      : Promise.resolve([]),
    idsByKind.get("project_fact")?.size
      ? client.projectFact.findMany({
          where: { id: { in: Array.from(idsByKind.get("project_fact")!) } },
          select: {
            id: true,
            lifecycleStatus: true,
            validatedThroughSha: true,
            status: true,
            statement: true,
          },
        })
      : Promise.resolve([]),
    idsByKind.get("artifact")?.size
      ? client.artifact.findMany({
          where: { id: { in: Array.from(idsByKind.get("artifact")!) } },
          select: { id: true, lifecycleStatus: true, validatedThroughSha: true, content: true },
        })
      : Promise.resolve([]),
  ]);
  const currentByEntity = new Map<string, Record<string, unknown>>([
    ...evidenceItems.map((entity) => [`evidence:${entity.id}`, entity] as const),
    ...highlights.map((entity) => [`highlight:${entity.id}`, entity] as const),
    ...projectFacts.map((entity) => [`project_fact:${entity.id}`, entity] as const),
    ...artifacts.map((entity) => [`artifact:${entity.id}`, entity] as const),
  ]);
  const safeInputs = inputs.filter((input) =>
    reviewSnapshotMatchesEntity({
      entityId: input.entityId,
      afterSnapshot: input.afterSnapshot,
      entity: currentByEntity.get(`${input.entityKind}:${input.entityId}`) ?? null,
    })
  );
  if (!safeInputs.length) return { count: 0 };
  const safelyResolvedEntities = new Set(safeInputs.map((input) =>
    `${input.workItemId}:${input.entityKind}:${input.entityId}`
  ));
  const safeInputByEntity = new Map(safeInputs.map((input) => [
    `${input.workItemId}:${input.entityKind}:${input.entityId}`,
    input,
  ]));
  const created = await client.knowledgeChange.createMany({
    data: safeInputs.map((input) => ({
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
  const pending = await client.knowledgeChange.findMany({
    where: {
      workItemId: { in: workItemIds },
      decision: "pending",
      OR: Array.from(idsByKind, ([kind, ids]) =>
        kind === "evidence"
          ? { evidenceItemId: { in: Array.from(ids) } }
          : kind === "highlight"
            ? { highlightId: { in: Array.from(ids) } }
            : kind === "project_fact"
              ? { projectFactId: { in: Array.from(ids) } }
              : { artifactId: { in: Array.from(ids) } }
      ),
    },
    select: {
      id: true,
      workItemId: true,
      action: true,
      afterSnapshot: true,
      evidenceItemId: true,
      highlightId: true,
      projectFactId: true,
      artifactId: true,
    },
  });
  const obsoleteIds = pending.flatMap((change) => {
    const after = change.afterSnapshot && typeof change.afterSnapshot === "object" && !Array.isArray(change.afterSnapshot)
      ? change.afterSnapshot as Record<string, unknown>
      : null;
    const lifecycleStatus = typeof after?.lifecycleStatus === "string"
      ? after.lifecycleStatus
      : null;
    const entityKind: EntityKind = change.evidenceItemId
      ? "evidence"
      : change.highlightId
        ? "highlight"
        : change.projectFactId
          ? "project_fact"
          : "artifact";
    const entityId = change.evidenceItemId ??
      change.highlightId ??
      change.projectFactId ??
      change.artifactId;
    if (
      !entityId ||
      !safelyResolvedEntities.has(`${change.workItemId}:${entityKind}:${entityId}`)
    ) return [];
    const safeInput = safeInputByEntity.get(`${change.workItemId}:${entityKind}:${entityId}`);
    const priorEntity = safeInput?.beforeSnapshot &&
      typeof safeInput.beforeSnapshot === "object" &&
      !Array.isArray(safeInput.beforeSnapshot)
      ? safeInput.beforeSnapshot as Record<string, unknown>
      : null;
    // Only close the exact warning that represented the state this automatic
    // transition just repaired. A newer lifecycle warning for the same entity
    // must remain visible even if it appears between the entity write and this
    // batched audit pass.
    if (
      !priorEntity ||
      !reviewSnapshotMatchesEntity({
        entityId,
        afterSnapshot: change.afterSnapshot,
        entity: priorEntity,
      })
    ) return [];
    return (
      lifecycleStatus === "needs_validation" ||
      lifecycleStatus === "stale" ||
      lifecycleStatus === "quarantined" ||
      change.action === "retired"
    ) ? [change.id] : [];
  });
  if (obsoleteIds.length) {
    await client.knowledgeChange.updateMany({
      where: { id: { in: obsoleteIds }, decision: "pending" },
      data: {
        decision: "retired",
        reviewedAt,
        feedback: "This lifecycle-warning card was resolved automatically because immutable repository content was unchanged.",
      },
    });
  }
  return created;
}

export function recordAutoResolvedKnowledgeChangesInTransaction(
  inputs: readonly AutoResolvedKnowledgeChangeInput[],
  client: Prisma.TransactionClient,
) {
  return recordAutoResolvedKnowledgeChangesOnce(inputs, client);
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
