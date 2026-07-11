import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";

type ReviewDecision = "keep" | "edit_and_keep" | "revert" | "retire";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function suffix(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function markDependentArtifactsStale(input: {
  workItemId: string;
  highlightId?: string;
  evidenceItemId?: string;
  reason: string;
}) {
  const artifacts = await prisma.artifact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: "active",
      OR: [
        ...(input.highlightId ? [{ highlightProvenance: { some: { highlightId: input.highlightId } } }] : []),
        ...(input.evidenceItemId ? [{ evidenceProvenance: { some: { evidenceItemId: input.evidenceItemId } } }] : []),
      ],
    },
  });
  for (const artifact of artifacts) {
    await prisma.artifact.update({
      where: { id: artifact.id },
      data: { lifecycleStatus: "stale", staleReason: input.reason },
    });
  }
  return artifacts.map((artifact) => artifact.id);
}

async function createEditedSuccessor(input: {
  change: Awaited<ReturnType<typeof loadAuthorizedChange>>;
  patch: Record<string, unknown>;
}) {
  const { change } = input;
  if (change.projectFact) {
    const statement = typeof input.patch.statement === "string" ? input.patch.statement.trim() : change.projectFact.statement;
    const category = typeof input.patch.category === "string" && ["architecture", "behavior", "data_flow", "code_location", "dependency", "configuration"].includes(input.patch.category)
      ? input.patch.category as typeof change.projectFact.category
      : change.projectFact.category;
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.projectFact.create({
        data: {
          workItemId: change.workItemId,
          statement,
          category,
          confidence: change.projectFact!.confidence,
          status: "approved",
          sensitivityFlag: typeof input.patch.sensitivityFlag === "boolean" ? input.patch.sensitivityFlag : change.projectFact!.sensitivityFlag,
          reviewNotes: typeof input.patch.reviewNotes === "string" ? input.patch.reviewNotes : change.projectFact!.reviewNotes,
          searchText: normalizeWhitespace([statement, category, typeof input.patch.reviewNotes === "string" ? input.patch.reviewNotes : change.projectFact!.reviewNotes ?? ""].join(" ")),
          supersedesProjectFactId: change.projectFact!.id,
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "not_eligible",
          validatedThroughSha: change.projectFact!.validatedThroughSha,
          lastValidatedAt: change.projectFact!.lastValidatedAt,
          subsystemKey: change.projectFact!.subsystemKey,
          evidence: { create: change.projectFact!.evidence.map((entry) => ({ evidenceItemId: entry.evidenceItemId, relevanceScore: entry.relevanceScore })) },
        },
      });
      await tx.projectFact.update({ where: { id: change.projectFact!.id }, data: { status: "superseded", lifecycleStatus: "superseded" } });
      return created;
    });
    return { kind: "project_fact" as const, id: successor.id };
  }
  if (change.highlight) {
    const text = typeof input.patch.text === "string" ? input.patch.text.trim() : change.highlight.text;
    const summary = typeof input.patch.summary === "string" ? input.patch.summary.trim() : change.highlight.summary;
    const visibility = typeof input.patch.visibility === "string" && ["private", "resume_safe", "linkedin_safe", "public_safe"].includes(input.patch.visibility)
      ? input.patch.visibility as typeof change.highlight.visibility
      : change.highlight.visibility;
    const tags = inferHighlightTags({ text, summary, verificationNotes: change.highlight.verificationNotes });
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.highlight.create({
        data: {
          workItemId: change.workItemId,
          text,
          summary,
          searchText: normalizeWhitespace([text, summary, change.highlight!.verificationNotes ?? ""].join(" ")),
          confidence: change.highlight!.confidence,
          ownershipClarity: change.highlight!.ownershipClarity,
          sensitivityFlag: typeof input.patch.sensitivityFlag === "boolean" ? input.patch.sensitivityFlag : change.highlight!.sensitivityFlag,
          verificationStatus: "approved",
          visibility,
          risksSummary: change.highlight!.risksSummary,
          missingInfo: change.highlight!.missingInfo,
          verificationNotes: typeof input.patch.reviewNotes === "string" ? input.patch.reviewNotes : change.highlight!.verificationNotes,
          metadata: change.highlight!.metadata ?? undefined,
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "pending",
          validatedThroughSha: change.highlight!.validatedThroughSha,
          lastValidatedAt: change.highlight!.lastValidatedAt,
          supersedesHighlightId: change.highlight!.id,
          evidence: { create: change.highlight!.evidence.map((entry) => ({ evidenceItemId: entry.evidenceItemId, relevanceScore: entry.relevanceScore })) },
          tags: { create: tags.map((tag) => ({ dimension: tag.dimension, tag: tag.tag, score: tag.score ?? null })) },
        },
      });
      await tx.highlight.update({ where: { id: change.highlight!.id }, data: { lifecycleStatus: "superseded" } });
      return created;
    });
    return { kind: "highlight" as const, id: successor.id };
  }
  if (change.evidenceItem) {
    const title = typeof input.patch.title === "string" ? input.patch.title.trim() : change.evidenceItem.title;
    const content = typeof input.patch.content === "string" ? input.patch.content.trim() : change.evidenceItem.content;
    const externalId = `correction:${change.evidenceItem.id}:${suffix(`${title}:${content}`)}`;
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.evidenceItem.create({
        data: {
          workItemId: change.workItemId,
          sourceId: change.evidenceItem!.sourceId,
          externalId,
          logicalKey: change.evidenceItem!.logicalKey ?? change.evidenceItem!.externalId,
          type: change.evidenceItem!.type,
          title,
          content,
          searchText: normalizeWhitespace([title, content].join(" ")),
          parentKind: "user_correction",
          parentKey: change.evidenceItem!.id,
          included: true,
          metadata: toInputJson({ correctedEvidenceId: change.evidenceItem!.id, originalMetadata: change.evidenceItem!.metadata }),
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "not_eligible",
          supersedesEvidenceItemId: change.evidenceItem!.id,
        },
      });
      await tx.evidenceItem.update({ where: { id: change.evidenceItem!.id }, data: { lifecycleStatus: "superseded" } });
      return created;
    });
    return { kind: "evidence" as const, id: successor.id };
  }
  if (change.artifact) {
    const content = typeof input.patch.content === "string" ? input.patch.content.trim() : change.artifact.content;
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.artifact.create({
        data: {
          userId: change.artifact!.userId,
          workItemId: change.artifact!.workItemId,
          type: change.artifact!.type,
          targetAngle: change.artifact!.targetAngle,
          tone: change.artifact!.tone,
          requestBrief: change.artifact!.requestBrief,
          content,
          searchText: normalizeWhitespace([change.artifact!.requestBrief, content].join(" ")),
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "pending",
          supersedesArtifactId: change.artifact!.id,
          highlightProvenance: { create: change.artifact!.highlightProvenance.map((entry) => ({ highlightId: entry.highlightId, highlightSnapshot: entry.highlightSnapshot as Prisma.InputJsonValue, rank: entry.rank, relevanceScore: entry.relevanceScore })) },
          evidenceProvenance: { create: change.artifact!.evidenceProvenance.map((entry) => ({ evidenceItemId: entry.evidenceItemId, evidenceSnapshot: entry.evidenceSnapshot as Prisma.InputJsonValue, rank: entry.rank, relevanceScore: entry.relevanceScore })) },
        },
      });
      await tx.artifact.update({ where: { id: change.artifact!.id }, data: { lifecycleStatus: "superseded" } });
      return created;
    });
    return { kind: "artifact" as const, id: successor.id };
  }
  throw new Error("The knowledge change no longer references an item.");
}

function loadAuthorizedChange(userId: string, changeId: string) {
  return prisma.knowledgeChange.findFirstOrThrow({
    where: { id: changeId, workItem: { userId } },
    include: {
      projectFact: { include: { evidence: true } },
      highlight: { include: { evidence: true } },
      evidenceItem: true,
      artifact: { include: { highlightProvenance: true, evidenceProvenance: true } },
    },
  });
}

async function setEntityReviewState(change: Awaited<ReturnType<typeof loadAuthorizedChange>>, reviewState: "reviewed" | "reverted") {
  if (change.projectFactId) await prisma.projectFact.updateMany({ where: { id: change.projectFactId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
  if (change.highlightId) await prisma.highlight.updateMany({ where: { id: change.highlightId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
  if (change.evidenceItemId) await prisma.evidenceItem.updateMany({ where: { id: change.evidenceItemId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
  if (change.artifactId) await prisma.artifact.updateMany({ where: { id: change.artifactId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
}

async function restorePredecessor(change: Awaited<ReturnType<typeof loadAuthorizedChange>>) {
  if (change.projectFact) {
    await prisma.projectFact.update({ where: { id: change.projectFact.id }, data: { lifecycleStatus: "retired", reviewState: "reverted", status: "rejected" } });
    if (change.projectFact.supersedesProjectFactId) await prisma.projectFact.update({ where: { id: change.projectFact.supersedesProjectFactId }, data: { lifecycleStatus: "active", status: "approved" } });
  } else if (change.highlight) {
    await prisma.highlight.update({ where: { id: change.highlight.id }, data: { lifecycleStatus: "retired", reviewState: "reverted" } });
    if (change.highlight.supersedesHighlightId) await prisma.highlight.update({ where: { id: change.highlight.supersedesHighlightId }, data: { lifecycleStatus: "active" } });
    await markDependentArtifactsStale({ workItemId: change.workItemId, highlightId: change.highlight.id, reason: "An automatically applied Highlight was reverted." });
  } else if (change.evidenceItem) {
    await prisma.evidenceItem.update({ where: { id: change.evidenceItem.id }, data: { lifecycleStatus: "retired", reviewState: "reverted" } });
    if (change.evidenceItem.supersedesEvidenceItemId) await prisma.evidenceItem.update({ where: { id: change.evidenceItem.supersedesEvidenceItemId }, data: { lifecycleStatus: "active" } });
    await markDependentArtifactsStale({ workItemId: change.workItemId, evidenceItemId: change.evidenceItem.id, reason: "Automatically applied Evidence was reverted." });
  } else if (change.artifact) {
    await prisma.artifact.update({ where: { id: change.artifact.id }, data: { lifecycleStatus: "retired", reviewState: "reverted" } });
    if (change.artifact.supersedesArtifactId) await prisma.artifact.update({ where: { id: change.artifact.supersedesArtifactId }, data: { lifecycleStatus: "active", staleReason: null } });
  }
}

async function retireEntity(change: Awaited<ReturnType<typeof loadAuthorizedChange>>, feedback?: string | null) {
  if (change.projectFact) await prisma.projectFact.update({ where: { id: change.projectFact.id }, data: { lifecycleStatus: "retired", status: "rejected", rejectionReason: feedback ?? "Retired during knowledge review.", reviewState: "reviewed" } });
  if (change.highlight) {
    await prisma.highlight.update({ where: { id: change.highlight.id }, data: { lifecycleStatus: "retired", rejectionReason: feedback ?? "Retired during knowledge review.", reviewState: "reviewed" } });
    await markDependentArtifactsStale({ workItemId: change.workItemId, highlightId: change.highlight.id, reason: "A supporting Highlight was retired." });
  }
  if (change.evidenceItem) {
    await prisma.evidenceItem.update({ where: { id: change.evidenceItem.id }, data: { lifecycleStatus: "retired", included: false, purgeEligibleAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), reviewState: "reviewed" } });
    await markDependentArtifactsStale({ workItemId: change.workItemId, evidenceItemId: change.evidenceItem.id, reason: "Supporting Evidence was retired." });
  }
  if (change.artifact) await prisma.artifact.update({ where: { id: change.artifact.id }, data: { lifecycleStatus: "retired", reviewState: "reviewed", staleReason: feedback ?? change.artifact.staleReason } });
}

export async function resolveKnowledgeChange(input: {
  userId: string;
  changeId: string;
  decision: ReviewDecision;
  patch?: Record<string, unknown>;
  feedback?: string | null;
}) {
  const change = await loadAuthorizedChange(input.userId, input.changeId);
  if (change.decision !== "pending") return { changeId: change.id, decision: change.decision, successor: null };
  let successor: { kind: string; id: string } | null = null;
  if (input.decision === "keep") {
    await setEntityReviewState(change, "reviewed");
  } else if (input.decision === "edit_and_keep") {
    successor = await createEditedSuccessor({ change, patch: input.patch ?? {} });
  } else if (input.decision === "revert") {
    await restorePredecessor(change);
  } else {
    await retireEntity(change, input.feedback);
  }
  const decision = input.decision === "keep"
    ? "kept"
    : input.decision === "edit_and_keep"
      ? "edited_and_kept"
      : input.decision === "revert"
        ? "reverted"
        : "retired";
  await prisma.knowledgeChange.update({
    where: { id: change.id },
    data: { decision, reviewedAt: new Date(), reviewedByUserId: input.userId, feedback: input.feedback ?? null },
  });
  return { changeId: change.id, decision, successor };
}

export async function purgeExpiredUnreferencedEvidence(now = new Date()) {
  const candidates = await prisma.evidenceItem.findMany({
    where: { lifecycleStatus: { in: ["retired", "stale"] }, purgeEligibleAt: { lte: now } },
    include: {
      highlightEvidence: true,
      projectFactEvidence: true,
      artifactProvenance: true,
      chatCitations: true,
      knowledgeChanges: true,
      supersededByEvidenceItems: true,
    },
  });
  const ids = candidates.filter((item) =>
    !item.highlightEvidence.length &&
    !item.projectFactEvidence.length &&
    !item.artifactProvenance.length &&
    !item.chatCitations.length &&
    !item.knowledgeChanges.length &&
    !item.supersededByEvidenceItems.length,
  ).map((item) => item.id);
  if (ids.length) await prisma.evidenceItem.deleteMany({ where: { id: { in: ids } } });
  return ids;
}

async function createManualLifecycleChange(input: {
  userId: string;
  workItemId: string;
  kind: "evidence" | "highlight" | "project_fact" | "artifact";
  entityId: string;
  action: "updated" | "retired";
  idempotencyKey: string;
  reason: string;
}) {
  const workItem = await prisma.workItem.findFirst({ where: { id: input.workItemId, userId: input.userId }, select: { id: true } });
  if (!workItem) throw new Error("The Work Item is not available.");
  const entity = input.kind === "evidence"
    ? await prisma.evidenceItem.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } })
    : input.kind === "highlight"
      ? await prisma.highlight.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } })
      : input.kind === "project_fact"
        ? await prisma.projectFact.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } })
        : await prisma.artifact.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } });
  if (!entity) throw new Error("The knowledge item is not available.");
  const relation = input.kind === "evidence"
    ? { evidenceItemId: input.entityId }
    : input.kind === "highlight"
      ? { highlightId: input.entityId }
      : input.kind === "project_fact"
        ? { projectFactId: input.entityId }
        : { artifactId: input.entityId };
  return prisma.knowledgeChange.upsert({
    where: { workItemId_idempotencyKey: { workItemId: input.workItemId, idempotencyKey: input.idempotencyKey } },
    create: {
      workItemId: input.workItemId,
      entityKind: input.kind,
      action: input.action,
      ...relation,
      beforeSnapshot: toInputJson(entity),
      reason: input.reason,
      policyVersion: "knowledge-lifecycle-v1",
      idempotencyKey: input.idempotencyKey,
    },
    update: {},
  });
}

export const knowledgeLifecycleService = {
  async edit(input: {
    userId: string;
    workItemId: string;
    kind: "evidence" | "highlight" | "project_fact" | "artifact";
    entityId: string;
    patch: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    const change = await createManualLifecycleChange({ ...input, action: "updated", reason: "The user requested a versioned knowledge edit." });
    const resolved = await resolveKnowledgeChange({ userId: input.userId, changeId: change.id, decision: "edit_and_keep", patch: input.patch });
    if (!resolved.successor) throw new Error("The edited successor was not created.");
    return { successorId: resolved.successor.id };
  },
  async retire(input: {
    userId: string;
    workItemId: string;
    kind: "evidence" | "highlight" | "project_fact" | "artifact";
    entityId: string;
    reason?: string | null;
    idempotencyKey: string;
  }) {
    const change = await createManualLifecycleChange({ ...input, action: "retired", reason: input.reason ?? "The user requested retirement." });
    await resolveKnowledgeChange({ userId: input.userId, changeId: change.id, decision: "retire", feedback: input.reason });
    return { entityId: input.entityId, lifecycleStatus: "retired" as const };
  },
};

export const knowledgeReviewService = {
  resolve: resolveKnowledgeChange,
  purgeExpiredEvidence: purgeExpiredUnreferencedEvidence,
};
