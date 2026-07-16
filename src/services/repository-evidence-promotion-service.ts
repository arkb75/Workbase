import { createHash } from "node:crypto";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import { buildEvidenceSearchText, inferEvidenceTags } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { upsertReviewableKnowledgeChange } from "@/src/services/knowledge-change-service";

export async function promoteRepositoryCitations(input: {
  workItemId: string;
  citations: readonly ProjectKnowledgeCitation[];
  reviewScope?: string;
  refreshRunId?: string | null;
}) {
  const promotedIds: string[] = [];
  const newIds: string[] = [];
  const evidenceIdByCitationIndex = new Map<number, string>();
  const sourceById = new Map<string, Awaited<ReturnType<typeof prisma.source.findFirst>>>();

  for (const [citationIndex, citation] of input.citations.entries()) {
    if (
      citation.kind !== "github_file" ||
      !citation.sourceId ||
      !citation.repository ||
      !citation.commitSha ||
      !citation.blobSha ||
      !citation.path ||
      !citation.startLine ||
      !citation.endLine
    ) continue;

    let source = sourceById.get(citation.sourceId);
    if (source === undefined) {
      source = await prisma.source.findFirst({
        where: { id: citation.sourceId, workItemId: input.workItemId, type: "github_repo" },
      });
      sourceById.set(citation.sourceId, source);
    }
    if (!source) continue;

    const excerptHash = createHash("sha256").update(citation.excerpt).digest("hex");
    const externalId = [
      "file",
      citation.commitSha,
      citation.path,
      citation.startLine,
      citation.endLine,
      excerptHash.slice(0, 12),
    ].join(":");
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
    };
    const existing = await prisma.evidenceItem.findUnique({
      where: { sourceId_externalId: { sourceId: source.id, externalId } },
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
      },
    });
    const reviewScope = input.reviewScope ?? `citation:${citation.commitSha}:${citation.blobSha}`;
    if (existing) {
      const existingReviewKey = `${reviewScope}:promoted-evidence:${existing.id}`;
      const priorReview = await prisma.knowledgeChange.findUnique({
        where: {
          workItemId_idempotencyKey: {
            workItemId: input.workItemId,
            idempotencyKey: existingReviewKey,
          },
        },
        select: { id: true },
      });
      if (priorReview) {
        // A durable workflow retry has already completed this immutable
        // promotion. Avoid rewriting metadata timestamps and rebuilding tags;
        // both create noise and can make old evidence look artificially new.
        promotedIds.push(existing.id);
        evidenceIdByCitationIndex.set(citationIndex, existing.id);
        continue;
      }
    }
    const evidence = await prisma.evidenceItem.upsert({
      where: { sourceId_externalId: { sourceId: source.id, externalId } },
      create: {
        workItemId: input.workItemId,
        sourceId: source.id,
        externalId,
        type: "github_file_excerpt",
        title: `${citation.path}:${citation.startLine}-${citation.endLine}`,
        content: citation.excerpt,
        searchText: buildEvidenceSearchText({ title: citation.path, content: citation.excerpt, metadata }),
        parentKind: "github_file",
        parentKey: `${citation.commitSha}:${citation.path}`,
        included: false,
        metadata,
      },
      update: { content: citation.excerpt, searchText: buildEvidenceSearchText({ title: citation.path, content: citation.excerpt, metadata }), metadata },
    });
    const reviewKey = `${reviewScope}:promoted-evidence:${evidence.id}`;
    const priorReview = await prisma.knowledgeChange.findUnique({
      where: {
        workItemId_idempotencyKey: {
          workItemId: input.workItemId,
          idempotencyKey: reviewKey,
        },
      },
      select: { id: true },
    });
    if (!priorReview) {
      await prisma.evidenceItem.update({
        where: { id: evidence.id },
        data: {
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
          validatedThroughSha: citation.commitSha,
          lastValidatedAt: new Date(),
          autoAppliedAt: new Date(),
        },
      });
      await upsertReviewableKnowledgeChange({
        workItemId: input.workItemId,
        refreshRunId: input.refreshRunId,
        entityKind: "evidence",
        action: existing ? "revalidated" : "created",
        entityId: evidence.id,
        beforeSnapshot: existing
          ? {
              id: existing.id,
              title: existing.title,
              content: existing.content,
              included: existing.included,
              lifecycleStatus: existing.lifecycleStatus,
              reviewState: existing.reviewState,
              approvalSource: existing.approvalSource,
              publicSafetyStatus: existing.publicSafetyStatus,
              validatedThroughSha: existing.validatedThroughSha,
              lastValidatedAt: existing.lastValidatedAt,
              autoAppliedAt: existing.autoAppliedAt,
            }
          : undefined,
        afterSnapshot: {
          id: evidence.id,
          title: evidence.title,
          content: evidence.content,
          included: existing?.included ?? false,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
          validatedThroughSha: citation.commitSha,
        },
        reason: existing
          ? "A repository workflow revalidated this immutable excerpt for later review."
          : "A repository workflow promoted this immutable excerpt for later review.",
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
      });
    }
    const tags = inferEvidenceTags({
      title: evidence.title,
      content: evidence.content,
      sourceType: "github_repo",
      evidenceType: "github_file_excerpt",
    });
    await prisma.evidenceTag.deleteMany({ where: { evidenceItemId: evidence.id } });
    if (tags.length) {
      await prisma.evidenceTag.createMany({
        data: tags.map((tag) => ({
          evidenceItemId: evidence.id,
          dimension: tag.dimension,
          tag: tag.tag,
          score: tag.score ?? null,
        })),
        skipDuplicates: true,
      });
    }
    promotedIds.push(evidence.id);
    evidenceIdByCitationIndex.set(citationIndex, evidence.id);
    if (!existing) newIds.push(evidence.id);
  }

  return { promotedIds, newIds, evidenceIdByCitationIndex };
}
