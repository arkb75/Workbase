import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: { findMany: vi.fn() },
  knowledgeRefreshRun: { findUnique: vi.fn() },
  evidenceItem: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  evidenceTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  knowledgeChange: { findUnique: vi.fn() },
}));
const upsertReviewableKnowledgeChangeMock = vi.hoisted(() => vi.fn());
const recordAutoResolvedKnowledgeChangesMock = vi.hoisted(() => vi.fn());
const upsertReviewableKnowledgeChangeInTransactionMock = vi.hoisted(() => vi.fn());
const recordAutoResolvedKnowledgeChangesInTransactionMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChange: upsertReviewableKnowledgeChangeMock,
  recordAutoResolvedKnowledgeChanges: recordAutoResolvedKnowledgeChangesMock,
  upsertReviewableKnowledgeChangeInTransaction: upsertReviewableKnowledgeChangeInTransactionMock,
  recordAutoResolvedKnowledgeChangesInTransaction: recordAutoResolvedKnowledgeChangesInTransactionMock,
}));

import { promoteRepositoryCitations } from "@/src/services/repository-evidence-promotion-service";

function mockEvidenceRows(
  initialRows: Array<Record<string, unknown>>,
  finalRows = initialRows,
) {
  prismaMock.evidenceItem.findMany.mockImplementation(async (args: {
    where?: { id?: { in?: string[] } };
  }) => {
    const finalIds = args.where?.id?.in;
    return finalIds
      ? finalRows.filter((row) => typeof row.id === "string" && finalIds.includes(row.id))
      : initialRows;
  });
}

describe("repository Evidence promotion lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.source.findMany.mockResolvedValue([{ id: "source-1" }]);
    prismaMock.knowledgeRefreshRun.findUnique.mockResolvedValue({
      startedAt: new Date("2026-07-16T00:00:00.000Z"),
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      targetHeads: [{ sourceId: "source-1", commitSha: "commit-1" }],
    });
    mockEvidenceRows([], [{ id: "evidence-1" }]);
    prismaMock.evidenceItem.findUnique.mockResolvedValue(null);
    prismaMock.evidenceItem.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.evidenceItem.upsert.mockResolvedValue({
      id: "evidence-1",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date("2026-07-16T00:00:00.000Z"),
      logicalKey: "github_file:src/runtime.ts:10:14",
      repositorySnapshotId: null,
      tags: [],
    });
    prismaMock.knowledgeChange.findUnique.mockResolvedValue(null);
    upsertReviewableKnowledgeChangeMock.mockResolvedValue({ id: "change-1" });
    recordAutoResolvedKnowledgeChangesMock.mockResolvedValue({ count: 0 });
    upsertReviewableKnowledgeChangeInTransactionMock.mockResolvedValue({ id: "change-1" });
    recordAutoResolvedKnowledgeChangesInTransactionMock.mockResolvedValue({ count: 0 });
  });

  it("persists no old-head Evidence when a newer generation wins before the fenced mutation phase", async () => {
    let releaseFence!: () => void;
    const fenceReleased = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    let fenceEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      fenceEntered = resolve;
    });
    const mutationFence = vi.fn(async () => {
      fenceEntered();
      await fenceReleased;
      throw new Error("Repository refresh refresh-old was superseded by refresh-new.");
    });

    const promotion = promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-old",
      reviewScope: "knowledge-refresh:refresh-old",
      repositorySnapshotIdByHead: new Map([["source-1:commit-old", "snapshot-old"]]),
      mutationFence,
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function oldRun() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-old",
        blobSha: "blob-old",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });
    await entered;
    // This release represents the newer refresh acquiring generation
    // ownership before the old promotion transaction is admitted.
    releaseFence();

    await expect(promotion).rejects.toThrow("superseded");
    expect(prismaMock.evidenceItem.upsert).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.createMany).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeInTransactionMock).not.toHaveBeenCalled();
  });

  it("keeps refresh Evidence, tags, and review cards inside one admitted mutation fence", async () => {
    const mutationFence = vi.fn(async (
      operation: (client: typeof prismaMock) => Promise<unknown>,
    ) => operation(prismaMock));

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      reviewScope: "knowledge-refresh:refresh-1",
      repositorySnapshotIdByHead: new Map([["source-1:commit-1", "snapshot-1"]]),
      mutationFence: mutationFence as never,
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual(["evidence-1"]);
    expect(mutationFence).toHaveBeenCalledOnce();
    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        logicalKey: "github_file:src/runtime.ts:10:14",
        repositorySnapshotId: "snapshot-1",
      }),
    }));
    expect(upsertReviewableKnowledgeChangeInTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "evidence-1" }),
      prismaMock,
    );
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
  });

  it("creates a reviewable, commit-pinned card for every newly promoted excerpt", async () => {
    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      reviewScope: "artifact-research:run-1:batch:1",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual(["evidence-1"]);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        validatedThroughSha: "commit-1",
      }),
    }));
    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      refreshRunId: "refresh-1",
      entityKind: "evidence",
      entityId: "evidence-1",
      action: "created",
      idempotencyKey: expect.stringMatching(/^artifact-research:run-1:batch:1:promoted-evidence:/),
      provenance: expect.objectContaining({
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
      }),
    }));
  });

  it("serializes review-card transactions while keeping a multi-excerpt promotion batch", async () => {
    const paths = ["src/first.ts", "src/second.ts", "src/third.ts"];
    mockEvidenceRows([], paths.map((_path, index) => ({ id: `evidence-${index + 1}` })));
    let evidenceOrdinal = 0;
    prismaMock.evidenceItem.upsert.mockImplementation(async (args: {
      create: { title: string; content: string };
    }) => {
      evidenceOrdinal += 1;
      return {
        id: `evidence-${evidenceOrdinal}`,
        title: args.create.title,
        content: args.create.content,
        included: false,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        validatedThroughSha: "commit-1",
        lastValidatedAt: new Date(),
        tags: [],
      };
    });
    let activeReviewTransactions = 0;
    let maximumConcurrentReviewTransactions = 0;
    upsertReviewableKnowledgeChangeMock.mockImplementation(async () => {
      activeReviewTransactions += 1;
      maximumConcurrentReviewTransactions = Math.max(
        maximumConcurrentReviewTransactions,
        activeReviewTransactions,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeReviewTransactions -= 1;
      return { id: "change" };
    });

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "research:multi-excerpt",
      citations: paths.map((path, index) => ({
        kind: "github_file" as const,
        label: path,
        excerpt: `export const value${index} = ${index};`,
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: `blob-${index + 1}`,
        path,
        startLine: 1,
        endLine: 1,
      })),
    });

    expect(result.promotedIds).toEqual([
      "evidence-1",
      "evidence-2",
      "evidence-3",
    ]);
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledTimes(3);
    expect(maximumConcurrentReviewTransactions).toBe(1);
  });

  it("does not reopen an already recorded promotion card during workflow retry", async () => {
    mockEvidenceRows([{
      id: "evidence-1",
      sourceId: "source-1",
      externalId: "legacy-external-id",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date("2026-07-15T00:00:00.000Z"),
      autoAppliedAt: new Date(),
      metadata: {
        blobSha: "blob-1",
        excerptHash: "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18",
      },
    }]);

    await promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "project-fact-research:run-1",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.upsert).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
  });

  it("reuses unchanged blobs across commits and promotes only genuinely new excerpt content", async () => {
    const reusedContent = "export function run() {}";
    const reusedHash = "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18";
    const existingEvidence = {
      id: "evidence-existing",
      sourceId: "source-1",
      externalId: "legacy-commit-scoped-id",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: reusedContent,
      included: true,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-old",
      lastValidatedAt: new Date("2026-07-15T00:00:00.000Z"),
      autoAppliedAt: new Date(),
      metadata: { blobSha: "blob-shared", excerptHash: reusedHash },
    };
    mockEvidenceRows(
      [existingEvidence],
      [existingEvidence, { id: "evidence-new" }],
    );
    prismaMock.evidenceItem.upsert.mockResolvedValue({
      id: "evidence-new",
      title: "src/new.ts:1-2",
      content: "export const added = true;",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      validatedThroughSha: "commit-new",
      lastValidatedAt: new Date("2026-07-16T00:00:00.000Z"),
      logicalKey: "github_file:src/new.ts:1:2",
      repositorySnapshotId: null,
      tags: [],
    });
    prismaMock.knowledgeRefreshRun.findUnique.mockResolvedValue({
      startedAt: new Date("2026-07-16T00:00:00.000Z"),
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      targetHeads: [{ sourceId: "source-1", commitSha: "commit-new" }],
    });

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-2",
      citations: [
        {
          kind: "github_file",
          label: "src/runtime.ts",
          excerpt: reusedContent,
          sourceId: "source-1",
          repository: "owner/repo",
          commitSha: "commit-new",
          blobSha: "blob-shared",
          path: "src/runtime.ts",
          startLine: 10,
          endLine: 14,
        },
        {
          kind: "github_file",
          label: "src/runtime.ts",
          excerpt: reusedContent,
          sourceId: "source-1",
          repository: "owner/repo",
          commitSha: "commit-newer",
          blobSha: "blob-shared",
          path: "src/runtime.ts",
          startLine: 10,
          endLine: 14,
        },
        {
          kind: "github_file",
          label: "src/new.ts",
          excerpt: "export const added = true;",
          sourceId: "source-1",
          repository: "owner/repo",
          commitSha: "commit-new",
          blobSha: "blob-new",
          path: "src/new.ts",
          startLine: 1,
          endLine: 2,
        },
      ],
    });

    expect(prismaMock.source.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(1);
    expect(result.evidenceIdByCitationIndex.get(0)).toBe("evidence-existing");
    expect(result.evidenceIdByCitationIndex.get(1)).toBe("evidence-existing");
    expect(result.evidenceIdByCitationIndex.get(2)).toBe("evidence-new");
    expect(result.newIds).toEqual(["evidence-new"]);
    expect(prismaMock.evidenceItem.updateMany).toHaveBeenCalledTimes(1);
    expect(recordAutoResolvedKnowledgeChangesMock).toHaveBeenCalledTimes(1);
  });

  it("promotes duplicate new excerpt citations once and maps every citation index", async () => {
    const citation = {
      kind: "github_file" as const,
      label: "src/runtime.ts",
      excerpt: "export function run() {}",
      sourceId: "source-1",
      repository: "owner/repo",
      commitSha: "commit-1",
      blobSha: "blob-1",
      path: "src/runtime.ts",
      startLine: 10,
      endLine: 14,
    };

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      citations: [citation, { ...citation, label: "same excerpt, second claim" }],
    });

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledTimes(1);
    expect(result.promotedIds).toEqual(["evidence-1"]);
    expect(result.newIds).toEqual(["evidence-1"]);
    expect(result.evidenceIdByCitationIndex.get(0)).toBe("evidence-1");
    expect(result.evidenceIdByCitationIndex.get(1)).toBe("evidence-1");
  });

  it("drops promoted ids that are no longer reusable at the final authoritative read", async () => {
    mockEvidenceRows([], []);

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(1);
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledTimes(1);
    expect(result.promotedIds).toEqual([]);
    expect(result.newIds).toEqual([]);
    expect(result.evidenceIdByCitationIndex.size).toBe(0);
    expect(prismaMock.evidenceItem.findMany).toHaveBeenLastCalledWith({
      where: {
        workItemId: "work-1",
        id: { in: ["evidence-1"] },
        type: "github_file_excerpt",
        lifecycleStatus: { in: ["active", "needs_validation", "stale"] },
        reviewState: { not: "reverted" },
      },
      select: { id: true },
    });
  });

  it("reuses legacy commit-scoped evidence whose logical key has not been backfilled", async () => {
    mockEvidenceRows([{
      id: "legacy-evidence",
      sourceId: "source-1",
      externalId: "file:old-commit:src/runtime.ts:10:14:71807b0a2eda",
      logicalKey: null,
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date("2026-07-16T00:00:00.000Z"),
      autoAppliedAt: new Date("2026-07-16T00:00:00.000Z"),
      purgeEligibleAt: null,
      metadata: {
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
        excerptHash: "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18",
      },
    }]);

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(prismaMock.evidenceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([expect.objectContaining({
          logicalKey: null,
          sourceId: "source-1",
          metadata: {
            path: ["blobSha"],
            equals: "blob-1",
          },
        })]),
      }),
    }));
    expect(result.promotedIds).toEqual(["legacy-evidence"]);
    expect(prismaMock.evidenceItem.upsert).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
  });

  it("creates a reviewable successor instead of resurrecting user-retired evidence", async () => {
    const retired = {
      id: "retired-evidence",
      sourceId: "source-1",
      externalId: "retired-external",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "retired",
      reviewState: "reviewed",
      approvalSource: "user",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date(),
      autoAppliedAt: new Date(),
      purgeEligibleAt: new Date(),
      metadata: {
        commitSha: "commit-1",
        blobSha: "blob-1",
        excerptHash: "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18",
      },
    };
    mockEvidenceRows([retired], [{ id: "successor-evidence" }]);
    prismaMock.evidenceItem.findUnique.mockResolvedValue(retired);
    prismaMock.evidenceItem.upsert.mockResolvedValue({
      id: "successor-evidence",
      title: retired.title,
      content: retired.content,
      lifecycleStatus: "active",
      reviewState: "reviewed",
    });

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "refresh:current",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: retired.content,
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual(["successor-evidence"]);
    expect(result.newIds).toEqual(["successor-evidence"]);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        supersedesEvidenceItemId: "retired-evidence",
        externalId: expect.stringContaining(":successor:"),
      }),
    }));
    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "retired-evidence" },
    }));
  });

  it("does not let a delayed older refresh regress current validation state", async () => {
    const excerptHash = "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18";
    const identity = `source-1:blob-1:github_file:src/runtime.ts:10:14:${excerptHash}`;
    const reviewKey = `refresh:old:promoted-evidence:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    prismaMock.knowledgeRefreshRun.findUnique.mockResolvedValue({
      startedAt: new Date("2026-07-15T00:00:00.000Z"),
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      targetHeads: [{ sourceId: "source-1", commitSha: "commit-old" }],
    });
    mockEvidenceRows([{
      id: "evidence-current",
      sourceId: "source-1",
      externalId: "stable",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-new",
      lastValidatedAt: new Date("2026-07-16T00:00:00.000Z"),
      autoAppliedAt: new Date(),
      purgeEligibleAt: null,
      metadata: {
        commitSha: "commit-original",
        blobSha: "blob-1",
        excerptHash,
        promotionReviewKey: reviewKey,
      },
    }]);

    await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-old",
      reviewScope: "refresh:old",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-old",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(prismaMock.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalled();
    expect(recordAutoResolvedKnowledgeChangesMock).not.toHaveBeenCalled();
  });

  it("does not audit or clear warnings when a guarded revalidation loses a race", async () => {
    prismaMock.knowledgeRefreshRun.findUnique.mockResolvedValue({
      startedAt: new Date("2026-07-16T00:00:00.000Z"),
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      targetHeads: [{ sourceId: "source-1", commitSha: "commit-new" }],
    });
    prismaMock.evidenceItem.findMany
      .mockResolvedValueOnce([{
        id: "evidence-raced",
        sourceId: "source-1",
        externalId: "stable",
        logicalKey: "github_file:src/runtime.ts:10:14",
        title: "src/runtime.ts:10-14",
        content: "export function run() {}",
        included: false,
        lifecycleStatus: "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: "commit-old",
        lastValidatedAt: new Date("2026-07-15T00:00:00.000Z"),
        autoAppliedAt: new Date(),
        purgeEligibleAt: null,
        metadata: {
          commitSha: "commit-old",
          blobSha: "blob-1",
          excerptHash: "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18",
        },
      }])
      .mockResolvedValueOnce([]);
    prismaMock.evidenceItem.updateMany.mockResolvedValue({ count: 0 });

    await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-current",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-new",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(prismaMock.evidenceItem.updateMany).toHaveBeenCalledTimes(1);
    expect(recordAutoResolvedKnowledgeChangesMock).not.toHaveBeenCalled();
  });

  it("repairs a missing review card when a promotion retry resumes after a partial write", async () => {
    const citation = {
      kind: "github_file" as const,
      label: "src/runtime.ts",
      excerpt: "export function run() {}",
      sourceId: "source-1",
      repository: "owner/repo",
      commitSha: "commit-1",
      blobSha: "blob-1",
      path: "src/runtime.ts",
      startLine: 10,
      endLine: 14,
    };
    upsertReviewableKnowledgeChangeMock
      .mockRejectedValueOnce(new Error("temporary review persistence failure"))
      .mockResolvedValueOnce({ id: "change-repaired" });

    await expect(promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "refresh:retryable",
      citations: [citation],
    })).rejects.toThrow("temporary review persistence failure");

    const create = prismaMock.evidenceItem.upsert.mock.calls[0]?.[0]?.create as {
      externalId: string;
      metadata: Record<string, unknown>;
    };
    mockEvidenceRows([{
      id: "evidence-1",
      sourceId: "source-1",
      externalId: create.externalId,
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: citation.excerpt,
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date(),
      autoAppliedAt: new Date(),
      purgeEligibleAt: null,
      metadata: create.metadata,
    }]);

    const repaired = await promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "refresh:retryable",
      citations: [citation],
    });

    expect(repaired.promotedIds).toEqual(["evidence-1"]);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(1);
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
  });

  it("repairs a missing card without letting an older refresh reactivate newer validation state", async () => {
    const excerptHash = "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18";
    const identity = `source-1:blob-1:github_file:src/runtime.ts:10:14:${excerptHash}`;
    const reviewKey = `refresh:old:promoted-evidence:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    prismaMock.knowledgeRefreshRun.findUnique.mockResolvedValue({
      startedAt: new Date("2026-07-15T00:00:00.000Z"),
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      targetHeads: [{ sourceId: "source-1", commitSha: "commit-old" }],
    });
    mockEvidenceRows([{
      id: "evidence-current",
      sourceId: "source-1",
      externalId: "stable",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "needs_validation",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-new",
      lastValidatedAt: new Date("2026-07-16T00:00:00.000Z"),
      autoAppliedAt: new Date("2026-07-16T00:00:00.000Z"),
      purgeEligibleAt: null,
      metadata: {
        blobSha: "blob-1",
        excerptHash,
        promotionReviewKey: reviewKey,
      },
      tags: [],
    }]);

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-old",
      reviewScope: "refresh:old",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-old",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual(["evidence-current"]);
    expect(prismaMock.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      afterSnapshot: expect.objectContaining({
        lifecycleStatus: "needs_validation",
        validatedThroughSha: "commit-new",
      }),
    }));
  });

  it("abandons repair when the evidence state CAS loses to a concurrent user decision", async () => {
    const excerptHash = "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18";
    const identity = `source-1:blob-1:github_file:src/runtime.ts:10:14:${excerptHash}`;
    const reviewKey = `refresh:race:promoted-evidence:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    mockEvidenceRows([{
      id: "evidence-raced",
      sourceId: "source-1",
      externalId: "stable",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "needs_validation",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-old",
      lastValidatedAt: new Date("2026-07-15T00:00:00.000Z"),
      autoAppliedAt: new Date("2026-07-15T00:00:00.000Z"),
      purgeEligibleAt: null,
      metadata: {
        blobSha: "blob-1",
        excerptHash,
        promotionReviewKey: reviewKey,
      },
      tags: [],
    }]);
    prismaMock.evidenceItem.updateMany.mockResolvedValue({ count: 0 });

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      reviewScope: "refresh:race",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual([]);
    expect(prismaMock.evidenceItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "evidence-raced",
        lifecycleStatus: "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
      }),
    }));
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.createMany).not.toHaveBeenCalled();
  });

  it("does not reopen an evidence item after the user has resolved its promotion card", async () => {
    const excerptHash = "71807b0a2eda29892dac6347e550644f984dbce994506c2400ea108dd49c4f18";
    const identity = `source-1:blob-1:github_file:src/runtime.ts:10:14:${excerptHash}`;
    const reviewKey = `refresh:reviewed:promoted-evidence:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    prismaMock.knowledgeChange.findUnique.mockResolvedValue({ decision: "kept" });
    mockEvidenceRows([{
      id: "evidence-reviewed",
      sourceId: "source-1",
      externalId: "stable",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "active",
      reviewState: "reviewed",
      approvalSource: "user",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date(),
      autoAppliedAt: new Date(),
      purgeEligibleAt: null,
      metadata: {
        commitSha: "commit-1",
        blobSha: "blob-1",
        excerptHash,
        promotionReviewKey: reviewKey,
      },
    }]);

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "refresh:reviewed",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: "export function run() {}",
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual(["evidence-reviewed"]);
    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
  });

  it("honors a retired successor when the original promotion workflow retries", async () => {
    const retiredOriginal = {
      id: "retired-original",
      sourceId: "source-1",
      externalId: "base",
      logicalKey: "github_file:src/runtime.ts:10:14",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
      included: false,
      lifecycleStatus: "retired",
      reviewState: "reviewed",
      approvalSource: "user",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: "commit-1",
      lastValidatedAt: new Date(),
      autoAppliedAt: new Date(),
      purgeEligibleAt: new Date(),
      metadata: { blobSha: "blob-1" },
    };
    const retiredSuccessor = {
      ...retiredOriginal,
      id: "retired-successor",
      externalId: "successor",
      reviewState: "reverted",
    };
    mockEvidenceRows([retiredOriginal, retiredSuccessor], []);
    prismaMock.evidenceItem.findUnique.mockResolvedValue(retiredOriginal);
    prismaMock.evidenceItem.upsert.mockResolvedValue(retiredSuccessor);

    const result = await promoteRepositoryCitations({
      workItemId: "work-1",
      reviewScope: "refresh:retry",
      citations: [{
        kind: "github_file",
        label: "src/runtime.ts",
        excerpt: retiredOriginal.content,
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
        startLine: 10,
        endLine: 14,
      }],
    });

    expect(result.promotedIds).toEqual([]);
    expect(prismaMock.evidenceItem.update).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
  });
});
