import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: { findFirst: vi.fn() },
  evidenceItem: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  evidenceTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  knowledgeChange: { findUnique: vi.fn() },
}));
const upsertReviewableKnowledgeChangeMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChange: upsertReviewableKnowledgeChangeMock,
}));

import { promoteRepositoryCitations } from "@/src/services/repository-evidence-promotion-service";

describe("repository Evidence promotion lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.source.findFirst.mockResolvedValue({ id: "source-1" });
    prismaMock.evidenceItem.findUnique.mockResolvedValue(null);
    prismaMock.evidenceItem.upsert.mockResolvedValue({
      id: "evidence-1",
      title: "src/runtime.ts:10-14",
      content: "export function run() {}",
    });
    prismaMock.knowledgeChange.findUnique.mockResolvedValue(null);
    upsertReviewableKnowledgeChangeMock.mockResolvedValue({ id: "change-1" });
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
    expect(prismaMock.evidenceItem.update).toHaveBeenCalledWith({
      where: { id: "evidence-1" },
      data: expect.objectContaining({
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        validatedThroughSha: "commit-1",
      }),
    });
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      refreshRunId: "refresh-1",
      entityKind: "evidence",
      entityId: "evidence-1",
      action: "created",
      idempotencyKey: "artifact-research:run-1:batch:1:promoted-evidence:evidence-1",
      provenance: expect.objectContaining({
        commitSha: "commit-1",
        blobSha: "blob-1",
        path: "src/runtime.ts",
      }),
    }));
  });

  it("does not reopen an already recorded promotion card during workflow retry", async () => {
    prismaMock.knowledgeChange.findUnique.mockResolvedValue({ id: "change-existing" });

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
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
  });
});
