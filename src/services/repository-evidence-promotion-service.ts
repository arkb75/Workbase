import { createHash } from "node:crypto";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import { Prisma } from "@/src/generated/prisma/client";
import { buildEvidenceSearchText, inferEvidenceTags } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { evidenceTagsAreCurrent } from "@/src/lib/evidence-persistence";
import {
  recordAutoResolvedKnowledgeChanges,
  recordAutoResolvedKnowledgeChangesInTransaction,
  upsertReviewableKnowledgeChange,
  upsertReviewableKnowledgeChangeInTransaction,
} from "@/src/services/knowledge-change-service";

const PROMOTION_CONCURRENCY = 8;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function logicalKeyForCitation(citation: {
  path: string;
  startLine: number;
  endLine: number;
}) {
  return `github_file:${citation.path}:${citation.startLine}:${citation.endLine}`;
}

function contentIdentity(input: {
  sourceId: string;
  blobSha: string;
  logicalKey: string;
  excerptHash: string;
}) {
  return `${input.sourceId}:${input.blobSha}:${input.logicalKey}:${input.excerptHash}`;
}

function isAutomaticallyReusableEvidence(evidence: {
  lifecycleStatus: string;
  reviewState: string;
}) {
  return (
    evidence.reviewState !== "reverted" &&
    (
      evidence.lifecycleStatus === "active" ||
      evidence.lifecycleStatus === "needs_validation" ||
      evidence.lifecycleStatus === "stale"
    )
  );
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
) {
  const results = Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        const value = values[index];
        if (value !== undefined) results[index] = await task(value, index);
      }
    },
  ));
  return results;
}

export async function promoteRepositoryCitations(input: {
  workItemId: string;
  citations: readonly ProjectKnowledgeCitation[];
  reviewScope?: string;
  refreshRunId?: string | null;
  repositorySnapshotIdByHead?: ReadonlyMap<string, string>;
  mutationFence?: <T>(
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
}) {
  const prepared = input.citations.flatMap((citation, citationIndex) => {
    if (
      citation.kind !== "github_file" ||
      !citation.sourceId ||
      !citation.repository ||
      !citation.commitSha ||
      !citation.blobSha ||
      !citation.path ||
      !citation.startLine ||
      !citation.endLine
    ) return [];
    const excerptHash = createHash("sha256").update(citation.excerpt).digest("hex");
    const logicalKey = logicalKeyForCitation({
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
    });
    const externalId = [
      "file",
      citation.blobSha,
      citation.path,
      citation.startLine,
      citation.endLine,
      excerptHash.slice(0, 12),
    ].join(":");
    return [{
      citation,
      citationIndex,
      excerptHash,
      logicalKey,
      externalId,
      identity: contentIdentity({
        sourceId: citation.sourceId,
        blobSha: citation.blobSha,
        logicalKey,
        excerptHash,
      }),
    }];
  });
  if (!prepared.length) {
    return {
      promotedIds: [],
      newIds: [],
      evidenceIdByCitationIndex: new Map<number, string>(),
    };
  }

  const sourceIds = Array.from(new Set(prepared.map((entry) => entry.citation.sourceId!)));
  const logicalKeys = Array.from(new Set(prepared.map((entry) => entry.logicalKey)));
  const externalIds = Array.from(new Set(prepared.map((entry) => entry.externalId)));
  const legacyBlobFilters = Array.from(new Map(prepared.map((entry) => [
    `${entry.citation.sourceId}:${entry.citation.blobSha}`,
    {
      logicalKey: null,
      sourceId: entry.citation.sourceId!,
      metadata: {
        path: ["blobSha"],
        equals: entry.citation.blobSha!,
      },
    },
  ])).values());
  const promoteWithClient = async (
    db: Prisma.TransactionClient,
    fenced: boolean,
  ) => {
  const [sources, existingEvidence, refreshRun] = await Promise.all([
    db.source.findMany({
      where: {
        id: { in: sourceIds },
        workItemId: input.workItemId,
        type: "github_repo",
      },
      select: { id: true },
    }),
    db.evidenceItem.findMany({
      where: {
        workItemId: input.workItemId,
        type: "github_file_excerpt",
        sourceId: { in: sourceIds },
        OR: [
          { logicalKey: { in: logicalKeys } },
          { externalId: { in: externalIds } },
          // Rows created before logical repository identities were introduced
          // can still be matched from their immutable blob metadata without
          // loading every historical unbackfilled excerpt in the project.
          ...legacyBlobFilters,
        ],
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        sourceId: true,
        externalId: true,
        logicalKey: true,
        title: true,
        content: true,
        included: true,
        lifecycleStatus: true,
        reviewState: true,
        approvalSource: true,
        publicSafetyStatus: true,
        validatedThroughSha: true,
        lastValidatedAt: true,
        autoAppliedAt: true,
        purgeEligibleAt: true,
        repositorySnapshotId: true,
        metadata: true,
        tags: {
          select: {
            dimension: true,
            tag: true,
            score: true,
          },
        },
      },
    }),
    input.refreshRunId
      ? db.knowledgeRefreshRun.findUnique({
          where: { id: input.refreshRunId },
          select: { startedAt: true, createdAt: true, targetHeads: true },
        })
      : Promise.resolve(null),
  ]);
  const authorizedSourceIds = new Set(sources.map((source) => source.id));
  const refreshTargetHeads = Array.isArray(refreshRun?.targetHeads)
    ? refreshRun.targetHeads.flatMap((target) => {
        const value = record(target);
        return typeof value?.sourceId === "string" && typeof value?.commitSha === "string"
          ? [`${value.sourceId}:${value.commitSha}`]
          : [];
      })
    : [];
  const authorizedRefreshHeads = new Set(refreshTargetHeads);
  const refreshStartedAt = refreshRun?.startedAt ?? refreshRun?.createdAt ?? null;
  // Serializable review-card transitions deliberately protect same-entity
  // ordering. Running many of those transactions concurrently for different
  // excerpts in one promotion batch can still create avoidable PostgreSQL
  // write conflicts on the shared pending-review indexes. Keep repository
  // reads and evidence upserts parallel, but serialize this short critical
  // section within the batch.
  let reviewCardMutationTail: Promise<void> = Promise.resolve();
  const serializeReviewCardMutation = <T>(task: () => Promise<T>) => {
    const result = reviewCardMutationTail.then(task, task);
    reviewCardMutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const existingByIdentity = new Map<string, (typeof existingEvidence)[number]>();
  for (const evidence of existingEvidence) {
    if (!isAutomaticallyReusableEvidence(evidence)) continue;
    const existingMetadata = record(evidence.metadata);
    const blobSha = typeof existingMetadata?.blobSha === "string" ? existingMetadata.blobSha : null;
    const excerptHash = typeof existingMetadata?.excerptHash === "string"
      ? existingMetadata.excerptHash
      : createHash("sha256").update(evidence.content).digest("hex");
    const logicalKey = evidence.logicalKey ??
      (
        typeof existingMetadata?.path === "string" &&
        typeof existingMetadata?.startLine === "number" &&
        typeof existingMetadata?.endLine === "number"
          ? logicalKeyForCitation({
              path: existingMetadata.path,
              startLine: existingMetadata.startLine,
              endLine: existingMetadata.endLine,
            })
          : null
      );
    if (!blobSha || !logicalKey) continue;
    const identity = contentIdentity({
      sourceId: evidence.sourceId,
      blobSha,
      logicalKey,
      excerptHash,
    });
    if (!existingByIdentity.has(identity)) existingByIdentity.set(identity, evidence);
  }

  // The same excerpt can support multiple candidate statements. Promote that
  // immutable content once, then fan its Evidence id back out to every
  // citation index. This avoids concurrent upsert/tag/review work for
  // duplicate citations inside one synthesis pass.
  const uniqueByIdentity = new Map<string, (typeof prepared)[number]>();
  for (const entry of prepared) {
    const existing = uniqueByIdentity.get(entry.identity);
    const entryIsCurrentRefreshHead = authorizedRefreshHeads.has(
      `${entry.citation.sourceId}:${entry.citation.commitSha}`,
    );
    const existingIsCurrentRefreshHead = existing
      ? authorizedRefreshHeads.has(`${existing.citation.sourceId}:${existing.citation.commitSha}`)
      : false;
    if (!existing || (entryIsCurrentRefreshHead && !existingIsCurrentRefreshHead)) {
      uniqueByIdentity.set(entry.identity, entry);
    }
  }
  const uniquePrepared = Array.from(uniqueByIdentity.values());
  async function ensureReviewablePromotion(inputEvidence: {
    id: string;
    title: string;
    content: string;
    included: boolean;
    lifecycleStatus: string;
    reviewState: string;
    approvalSource: string;
    validatedThroughSha: string | null;
    lastValidatedAt: Date | null;
    logicalKey?: string | null;
    repositorySnapshotId?: string | null;
    tags?: Array<{
      dimension: string;
      tag: string;
      score: number | null;
    }>;
  }, citation: ProjectKnowledgeCitation, reviewKey: string) {
    const recordedChange = await db.knowledgeChange.findUnique({
      where: {
        workItemId_idempotencyKey: {
          workItemId: input.workItemId,
          idempotencyKey: reviewKey,
        },
      },
      select: { decision: true },
    });
    // A resolved card is a user decision, not an interrupted automation
    // write. Reusing the evidence is fine, but a retry must never reopen it.
    if (recordedChange && recordedChange.decision !== "pending") {
      return isAutomaticallyReusableEvidence(inputEvidence);
    }
    const now = new Date();
    const refreshOwnsCitationHead = Boolean(
      !input.refreshRunId ||
      authorizedRefreshHeads.has(`${citation.sourceId}:${citation.commitSha}`),
    );
    const validationWasNotAdvancedByANewerRun = Boolean(
      !refreshStartedAt ||
      !inputEvidence.lastValidatedAt ||
      inputEvidence.lastValidatedAt.getTime() <= refreshStartedAt.getTime(),
    );
    const mayAdvanceValidation = refreshOwnsCitationHead && validationWasNotAdvancedByANewerRun;
    const logicalKey = logicalKeyForCitation({
      path: citation.path!,
      startLine: citation.startLine!,
      endLine: citation.endLine!,
    });
    const repositorySnapshotId = input.repositorySnapshotIdByHead?.get(
      `${citation.sourceId}:${citation.commitSha}`,
    );
    const effectiveValidationSha = mayAdvanceValidation
      ? citation.commitSha
      : inputEvidence.validatedThroughSha;
    const automationMayRepairState =
      inputEvidence.approvalSource !== "user" &&
      inputEvidence.reviewState !== "reverted";
    const shouldRepairState = mayAdvanceValidation &&
      automationMayRepairState &&
      (
        inputEvidence.lifecycleStatus !== "active" ||
        inputEvidence.reviewState !== "pending_review" ||
        inputEvidence.approvalSource !== "automation" ||
        inputEvidence.validatedThroughSha !== citation.commitSha ||
        inputEvidence.logicalKey !== logicalKey ||
        (
          repositorySnapshotId !== undefined &&
          inputEvidence.repositorySnapshotId !== repositorySnapshotId
        )
      );
    if (shouldRepairState) {
      // The row snapshot and the pending card are both part of the CAS. If a
      // user retires/reverts/reviews the item after this workflow loaded it,
      // the guarded update loses instead of restoring automation-owned state.
      const repaired = await db.evidenceItem.updateMany({
        where: {
          id: inputEvidence.id,
          lifecycleStatus: inputEvidence.lifecycleStatus as
            | "active"
            | "needs_validation"
            | "stale"
            | "superseded"
            | "retired"
            | "quarantined",
          reviewState: inputEvidence.reviewState as "pending_review" | "reviewed" | "reverted",
          approvalSource: inputEvidence.approvalSource as "automation" | "user" | "legacy",
          validatedThroughSha: inputEvidence.validatedThroughSha,
          lastValidatedAt: inputEvidence.lastValidatedAt,
        },
        data: {
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
          validatedThroughSha: effectiveValidationSha,
          lastValidatedAt: now,
          autoAppliedAt: now,
          purgeEligibleAt: null,
          logicalKey,
          repositorySnapshotId,
        },
      });
      if (repaired.count !== 1) return false;
    }
    const latestChange = await db.knowledgeChange.findUnique({
      where: {
        workItemId_idempotencyKey: {
          workItemId: input.workItemId,
          idempotencyKey: reviewKey,
        },
      },
      select: { decision: true },
    });
    if (latestChange && latestChange.decision !== "pending") {
      return isAutomaticallyReusableEvidence(inputEvidence);
    }
    if (!automationMayRepairState) return isAutomaticallyReusableEvidence(inputEvidence);
    const lifecycleStatus = shouldRepairState ? "active" : inputEvidence.lifecycleStatus;
    const reviewState = shouldRepairState ? "pending_review" : inputEvidence.reviewState;
    const approvalSource = shouldRepairState ? "automation" : inputEvidence.approvalSource;
    const reviewInput = {
        workItemId: input.workItemId,
        refreshRunId: input.refreshRunId,
        entityKind: "evidence",
        action: "created",
        entityId: inputEvidence.id,
        afterSnapshot: {
          id: inputEvidence.id,
          title: inputEvidence.title,
          content: inputEvidence.content,
          included: inputEvidence.included,
          lifecycleStatus,
          reviewState,
          approvalSource,
          validatedThroughSha: effectiveValidationSha,
        },
        reason: "A repository workflow promoted this immutable excerpt for later review.",
        provenance: {
          sourceId: citation.sourceId,
          repository: citation.repository,
          commitSha: citation.commitSha,
          blobSha: citation.blobSha,
          path: citation.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
        },
        policyVersion: "knowledge-lifecycle-v2",
        idempotencyKey: reviewKey,
      } as const;
    await serializeReviewCardMutation(() =>
      fenced
        ? upsertReviewableKnowledgeChangeInTransaction(reviewInput, db)
        : upsertReviewableKnowledgeChange(reviewInput)
    );
    const tags = inferEvidenceTags({
      title: inputEvidence.title,
      content: inputEvidence.content,
      sourceType: "github_repo",
      evidenceType: "github_file_excerpt",
    });
    const expectedTags = tags.map((tag) => ({
      dimension: tag.dimension,
      tag: tag.tag,
      score: tag.score ?? null,
    }));
    if (!evidenceTagsAreCurrent(inputEvidence.tags, expectedTags)) {
      // New immutable excerpts have no tags, and retries see the same inferred
      // tag identities. In both cases createMany(skipDuplicates) avoids a
      // destructive delete. Delete only when a known, non-empty prior tag set
      // must actually be replaced (for example after a tagging-policy change).
      if (inputEvidence.tags?.length) {
        await db.evidenceTag.deleteMany({ where: { evidenceItemId: inputEvidence.id } });
      }
    }
    if (!evidenceTagsAreCurrent(inputEvidence.tags, expectedTags) && expectedTags.length) {
      await db.evidenceTag.createMany({
        data: expectedTags.map((tag) => ({
          evidenceItemId: inputEvidence.id,
          ...tag,
        })),
        skipDuplicates: true,
      });
    }
    return true;
  }
  const results = await mapBounded(
    uniquePrepared,
    fenced ? 1 : PROMOTION_CONCURRENCY,
    async (entry) => {
    const { citation, citationIndex, excerptHash, logicalKey, externalId, identity } = entry;
    if (!authorizedSourceIds.has(citation.sourceId!)) return null;
    const reviewScope = input.reviewScope ?? `citation:${citation.commitSha}:${citation.blobSha}`;
    const reviewKey = `${reviewScope}:promoted-evidence:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    const exactExisting = existingByIdentity.get(identity);
    if (exactExisting) {
      const repositorySnapshotId = input.repositorySnapshotIdByHead?.get(
        `${citation.sourceId}:${citation.commitSha}`,
      );
      if (
        exactExisting.logicalKey !== logicalKey ||
        (
          repositorySnapshotId !== undefined &&
          exactExisting.repositorySnapshotId !== repositorySnapshotId
        )
      ) {
        const attached = await db.evidenceItem.updateMany({
          where: {
            id: exactExisting.id,
            lifecycleStatus: exactExisting.lifecycleStatus,
            reviewState: exactExisting.reviewState,
            approvalSource: exactExisting.approvalSource,
            validatedThroughSha: exactExisting.validatedThroughSha,
            lastValidatedAt: exactExisting.lastValidatedAt,
          },
          data: {
            logicalKey,
            repositorySnapshotId,
          },
        });
        if (attached.count !== 1) return null;
      }
      const existingMetadata = record(exactExisting.metadata);
      const promotionReviewKey = typeof existingMetadata?.promotionReviewKey === "string"
        ? existingMetadata.promotionReviewKey
        : null;
      if (
        promotionReviewKey === reviewKey &&
        !await ensureReviewablePromotion(exactExisting, citation, promotionReviewKey)
      ) {
        return null;
      }
      return {
        identity,
        citationIndex,
        evidenceId: exactExisting.id,
        isNew: false,
        previous: exactExisting,
        citation,
      };
    }
    const metadata = {
      managedBy: "project_research",
      repository: citation.repository,
      commitSha: citation.commitSha,
      blobSha: citation.blobSha,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      excerptHash,
      url: citation.url ?? null,
      fetchedAt: new Date().toISOString(),
      contentSafety: "untrusted_repository_content",
      redacted: citation.redacted ?? false,
      redactionCategories: citation.redactionCategories ?? [],
      promotionReviewKey: reviewKey,
    };
    const existing = await db.evidenceItem.findUnique({
      where: { sourceId_externalId: { sourceId: citation.sourceId!, externalId } },
      select: {
        id: true,
        title: true,
        content: true,
        included: true,
        lifecycleStatus: true,
        reviewState: true,
        approvalSource: true,
        publicSafetyStatus: true,
        validatedThroughSha: true,
        lastValidatedAt: true,
        autoAppliedAt: true,
        purgeEligibleAt: true,
        logicalKey: true,
        repositorySnapshotId: true,
        metadata: true,
        tags: {
          select: {
            dimension: true,
            tag: true,
            score: true,
          },
        },
      },
    });
    if (existing && isAutomaticallyReusableEvidence(existing)) {
      const repositorySnapshotId = input.repositorySnapshotIdByHead?.get(
        `${citation.sourceId}:${citation.commitSha}`,
      );
      if (
        existing.logicalKey !== logicalKey ||
        (
          repositorySnapshotId !== undefined &&
          existing.repositorySnapshotId !== repositorySnapshotId
        )
      ) {
        const attached = await db.evidenceItem.updateMany({
          where: {
            id: existing.id,
            lifecycleStatus: existing.lifecycleStatus,
            reviewState: existing.reviewState,
            approvalSource: existing.approvalSource,
            validatedThroughSha: existing.validatedThroughSha,
            lastValidatedAt: existing.lastValidatedAt,
          },
          data: {
            logicalKey,
            repositorySnapshotId,
          },
        });
        if (attached.count !== 1) return null;
      }
      const existingMetadata = record(existing.metadata);
      if (
        existingMetadata?.promotionReviewKey === reviewKey &&
        !await ensureReviewablePromotion(existing, citation, reviewKey)
      ) {
        return null;
      }
      return {
        identity,
        citationIndex,
        evidenceId: existing.id,
        isNew: false,
        previous: existing,
        citation,
      };
    }
    const effectiveExternalId = existing
      ? `${externalId}:successor:${createHash("sha256").update(reviewScope).digest("hex").slice(0, 10)}`
      : externalId;
    const now = new Date();
    const creationMayValidate = Boolean(
      !input.refreshRunId ||
      authorizedRefreshHeads.has(`${citation.sourceId}:${citation.commitSha}`),
    );
    const evidence = await db.evidenceItem.upsert({
      where: {
        sourceId_externalId: {
          sourceId: citation.sourceId!,
          externalId: effectiveExternalId,
        },
      },
      create: {
        workItemId: input.workItemId,
        sourceId: citation.sourceId!,
        externalId: effectiveExternalId,
        type: "github_file_excerpt",
        title: `${citation.path}:${citation.startLine}-${citation.endLine}`,
        content: citation.excerpt,
        searchText: buildEvidenceSearchText({ title: citation.path!, content: citation.excerpt, metadata }),
        parentKind: "github_file",
        parentKey: `${citation.commitSha}:${citation.path}`,
        logicalKey,
        included: false,
        metadata,
        lifecycleStatus: creationMayValidate ? "active" : "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
        validatedThroughSha: creationMayValidate ? citation.commitSha : null,
        lastValidatedAt: creationMayValidate ? now : null,
        autoAppliedAt: now,
        purgeEligibleAt: null,
        repositorySnapshotId: input.repositorySnapshotIdByHead?.get(
          `${citation.sourceId}:${citation.commitSha}`,
        ),
        supersedesEvidenceItemId: existing?.id,
      },
      update: {},
      include: {
        tags: {
          select: {
            dimension: true,
            tag: true,
            score: true,
          },
        },
      },
    });
    // A user may retire a previously auto-created successor before a workflow
    // retry reaches this point. The deterministic upsert then returns that
    // retired row; honoring the decision is safer than manufacturing another
    // successor or silently reactivating it.
    if (!isAutomaticallyReusableEvidence(evidence)) return null;
    if (!await ensureReviewablePromotion(evidence, citation, reviewKey)) return null;
    return {
      identity,
      citationIndex,
      evidenceId: evidence.id,
      isNew: true,
      previous: null,
      citation,
    };
    },
  );

  const resultByIdentity = new Map(
    results.flatMap((result) => result ? [[result.identity, result] as const] : []),
  );
  const promotedIds = new Set<string>();
  const newIds = new Set<string>();
  const evidenceIdByCitationIndex = new Map<number, string>();
  const reusedNeedingRevalidation = new Map<string, NonNullable<(typeof results)[number]>>();
  for (const entry of prepared) {
    const result = resultByIdentity.get(entry.identity);
    if (!result) continue;
    promotedIds.add(result.evidenceId);
    evidenceIdByCitationIndex.set(entry.citationIndex, result.evidenceId);
    if (result.isNew) newIds.add(result.evidenceId);
  }
  for (const result of results) {
    if (!result) continue;
    const priorMetadata = result.previous ? record(result.previous.metadata) : null;
    const originalCommitSha = typeof priorMetadata?.commitSha === "string"
      ? priorMetadata.commitSha
      : null;
    const refreshOwnsCitationHead = Boolean(
      input.refreshRunId &&
      authorizedRefreshHeads.has(`${result.citation.sourceId}:${result.citation.commitSha}`),
    );
    const validationWasNotAdvancedByANewerRun = Boolean(
      !refreshStartedAt ||
      !result.previous?.lastValidatedAt ||
      result.previous.lastValidatedAt.getTime() <= refreshStartedAt.getTime(),
    );
    if (
      !result.isNew &&
      result.previous &&
      refreshOwnsCitationHead &&
      validationWasNotAdvancedByANewerRun &&
      (
        result.previous.lifecycleStatus !== "active" ||
        result.previous.validatedThroughSha !== result.citation.commitSha ||
        result.previous.purgeEligibleAt ||
        (
          originalCommitSha !== null &&
          originalCommitSha !== result.citation.commitSha
        )
      )
    ) {
      reusedNeedingRevalidation.set(result.evidenceId, result);
    }
  }
  if (reusedNeedingRevalidation.size) {
    const validatedAt = new Date();
    const groups = new Map<string, string[]>();
    for (const result of reusedNeedingRevalidation.values()) {
      const group = groups.get(result.citation.commitSha!) ?? [];
      group.push(result.evidenceId);
      groups.set(result.citation.commitSha!, group);
    }
    const updatedIds = new Set<string>();
    await mapBounded(
      Array.from(groups),
      fenced ? 1 : PROMOTION_CONCURRENCY,
      async ([commitSha, ids]) => {
      const update = await db.evidenceItem.updateMany({
        where: {
          id: { in: ids },
          lifecycleStatus: { in: ["active", "needs_validation", "stale"] },
          reviewState: { not: "reverted" },
          ...(refreshStartedAt
            ? {
                OR: [
                  { lastValidatedAt: null },
                  { lastValidatedAt: { lte: refreshStartedAt } },
                ],
              }
            : {}),
        },
        data: {
          lifecycleStatus: "active",
          validatedThroughSha: commitSha,
          lastValidatedAt: validatedAt,
          purgeEligibleAt: null,
        },
      });
      if (update.count === ids.length) {
        for (const id of ids) updatedIds.add(id);
        return;
      }
      const confirmed = await db.evidenceItem.findMany({
        where: {
          id: { in: ids },
          validatedThroughSha: commitSha,
          lastValidatedAt: validatedAt,
        },
        select: { id: true },
      });
        for (const evidence of confirmed) updatedIds.add(evidence.id);
      },
    );
    const revalidatedResults = Array.from(reusedNeedingRevalidation.values())
      .filter((result) => updatedIds.has(result.evidenceId));
    const revalidationChanges = revalidatedResults.map((result) => ({
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: "evidence" as const,
      action: "revalidated" as const,
      entityId: result.evidenceId,
      beforeSnapshot: {
        id: result.evidenceId,
        title: result.previous!.title,
        lifecycleStatus: result.previous!.lifecycleStatus,
        validatedThroughSha: result.previous!.validatedThroughSha,
      },
      afterSnapshot: {
        id: result.evidenceId,
        title: result.previous!.title,
        lifecycleStatus: "active",
        validatedThroughSha: result.citation.commitSha,
      },
      reason: "The same immutable Git blob and exact line-range content are present at the current repository head.",
      provenance: {
        sourceId: result.citation.sourceId,
        repository: result.citation.repository,
        commitSha: result.citation.commitSha,
        blobSha: result.citation.blobSha,
        path: result.citation.path,
        startLine: result.citation.startLine,
        endLine: result.citation.endLine,
        automatic: true,
        contentAddressed: true,
      },
      policyVersion: "knowledge-lifecycle-v3",
      modelId: null,
      idempotencyKey: [
        "evidence",
        "content-addressed",
        result.evidenceId,
        result.citation.sourceId,
        result.citation.commitSha,
        result.citation.path,
        result.citation.blobSha,
      ].join(":"),
    }));
    if (revalidationChanges.length) {
      if (fenced) {
        await recordAutoResolvedKnowledgeChangesInTransaction(revalidationChanges, db);
      } else {
        await recordAutoResolvedKnowledgeChanges(revalidationChanges);
      }
    }
  }

  // Promotion work can overlap with review actions and later refreshes. Re-read
  // the authoritative rows immediately before returning so downstream
  // synthesis never receives an id that a concurrent decision already
  // reverted, retired, superseded, or quarantined.
  const candidatePromotedIds = Array.from(promotedIds);
  const reusableEvidence = candidatePromotedIds.length
    ? await db.evidenceItem.findMany({
        where: {
          workItemId: input.workItemId,
          id: { in: candidatePromotedIds },
          type: "github_file_excerpt",
          lifecycleStatus: { in: ["active", "needs_validation", "stale"] },
          reviewState: { not: "reverted" },
        },
        select: { id: true },
      })
    : [];
  const reusableIds = new Set(reusableEvidence.map((evidence) => evidence.id));
  const finalCitationMap = new Map(
    Array.from(evidenceIdByCitationIndex)
      .filter(([, evidenceId]) => reusableIds.has(evidenceId)),
  );

  return {
    promotedIds: candidatePromotedIds.filter((id) => reusableIds.has(id)),
    newIds: Array.from(newIds).filter((id) => reusableIds.has(id)),
    evidenceIdByCitationIndex: finalCitationMap,
  };
  };
  return input.mutationFence
    ? input.mutationFence((client) => promoteWithClient(client, true))
    : promoteWithClient(prisma as unknown as Prisma.TransactionClient, false);
}
