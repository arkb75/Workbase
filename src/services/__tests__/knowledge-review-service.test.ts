import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  knowledgeChange: {
    findFirstOrThrow: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  projectFact: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  highlight: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  evidenceItem: {
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  artifact: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const upsertProjectFactEmbeddingMock = vi.hoisted(() => vi.fn());
const upsertHighlightEmbeddingMock = vi.hoisted(() => vi.fn());
const invalidateHighlightDependentsMock = vi.hoisted(() => vi.fn());
const startKnowledgeRefreshMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/knowledge-embedding-service", () => ({
  buildProjectFactEmbeddingText: vi.fn((fact) => `${fact.category} ${fact.statement}`),
  upsertProjectFactEmbedding: upsertProjectFactEmbeddingMock,
}));
vi.mock("@/src/services/highlight-embedding-service", () => ({
  buildHighlightEmbeddingText: vi.fn((highlight) => `${highlight.text} ${highlight.summary}`),
  upsertHighlightEmbedding: upsertHighlightEmbeddingMock,
}));
vi.mock("@/src/services/knowledge-dependency-service", () => ({
  invalidateEvidenceDependents: vi.fn(),
  invalidateHighlightDependents: invalidateHighlightDependentsMock,
}));
vi.mock("@/src/services/repository-knowledge-refresh-application-service", () => ({
  repositoryKnowledgeRefreshApplicationService: {
    start: startKnowledgeRefreshMock,
  },
}));

import {
  knowledgeRevertMode,
  purgeExpiredUnreferencedEvidence,
  resolveKnowledgeChange,
} from "@/src/services/knowledge-review-service";

function transactionClient(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    knowledgeChange: prismaMock.knowledgeChange,
    projectFact: prismaMock.projectFact,
    projectFactEvidence: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    highlight: prismaMock.highlight,
    highlightEvidence: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    evidenceItem: prismaMock.evidenceItem,
    artifact: prismaMock.artifact,
    ...overrides,
  };
}

describe("knowledge review lifecycle integrity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.knowledgeChange.update.mockResolvedValue({});
    prismaMock.knowledgeChange.findFirst.mockResolvedValue(null);
    prismaMock.knowledgeChange.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback(transactionClient())
    );
    upsertProjectFactEmbeddingMock.mockResolvedValue({});
    upsertHighlightEmbeddingMock.mockResolvedValue({});
    invalidateHighlightDependentsMock.mockResolvedValue([]);
    startKnowledgeRefreshMock.mockResolvedValue({ runId: "refresh-1" });
  });

  it("keeps an edited Project Fact out of retrieval until it is revalidated and refreshes its embedding", async () => {
    const projectFact = {
      id: "fact-old",
      statement: "Old assertion",
      category: "architecture",
      confidence: "high",
      status: "approved",
      sensitivityFlag: false,
      reviewNotes: null,
      metadata: {
        schemaVersion: "repository-knowledge-metadata-v1",
        managedBy: "repository_knowledge_sync",
        refreshRunId: "refresh-old",
        subsystemKey: "ai_runtime",
        synthesisKey: "ai_runtime#operation-call",
        knowledgeRoles: ["implementation"],
        implementationStates: ["partial"],
        operationKeys: ["runtime.call"],
        operationFacets: ["boundary"],
      },
      subsystemKey: "ai_runtime",
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      distinctiveness: 4,
      evidence: [{ evidenceItemId: "evidence-1", relevanceScore: 1 }],
    };
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-1",
      workItemId: "work-1",
      action: "updated",
      decision: "pending",
      projectFact,
      highlight: null,
      evidenceItem: null,
      artifact: null,
    });
    const created = {
      ...projectFact,
      id: "fact-new",
      statement: "Edited assertion",
      lifecycleStatus: "needs_validation",
      validatedThroughSha: null,
    };
    const tx = {
      projectFact: {
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback(transactionClient(tx))
    );

    await resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-1",
      decision: "edit_and_keep",
      patch: { statement: "Edited assertion" },
    });

    expect(tx.projectFact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        statement: "Edited assertion",
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        lastValidatedAt: null,
        metadata: projectFact.metadata,
      }),
    });
    expect(upsertProjectFactEmbeddingMock).toHaveBeenCalledWith({
      projectFactId: "fact-new",
      inputText: "architecture Edited assertion",
    });
    expect(startKnowledgeRefreshMock).toHaveBeenCalledWith({
      userId: "user-1",
      workItemId: "work-1",
      trigger: "backfill",
      idempotencyKey: "knowledge-edit:project_fact:fact-new",
    });
  });

  it("keeps an edited Highlight out of retrieval, refreshes its embedding, and stales dependent Artifacts", async () => {
    const highlight = {
      id: "highlight-old",
      text: "Old highlight",
      summary: "Old summary",
      confidence: "high",
      ownershipClarity: "clear",
      sensitivityFlag: false,
      verificationStatus: "approved",
      visibility: "resume_safe",
      risksSummary: null,
      missingInfo: null,
      verificationNotes: "Verified",
      metadata: null,
      evidence: [{
        evidenceItemId: "evidence-1",
        relevanceScore: 1,
        evidenceItem: {
          id: "evidence-1",
          sourceId: "source-1",
          title: "Source",
          content: "Support",
          source: { id: "source-1", type: "github_repo", label: "GitHub" },
        },
      }],
      tags: [],
    };
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-2",
      workItemId: "work-1",
      action: "updated",
      decision: "pending",
      projectFact: null,
      highlight,
      evidenceItem: null,
      artifact: null,
    });
    const created = {
      ...highlight,
      id: "highlight-new",
      text: "Edited highlight",
      lifecycleStatus: "needs_validation",
      validatedThroughSha: null,
    };
    const tx = {
      highlight: {
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback(transactionClient(tx))
    );

    await resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-2",
      decision: "edit_and_keep",
      patch: { text: "Edited highlight" },
    });

    expect(tx.highlight.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        text: "Edited highlight",
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
      }),
    });
    expect(upsertHighlightEmbeddingMock).toHaveBeenCalledWith(expect.objectContaining({
      highlightId: "highlight-new",
      inputText: "Edited highlight Old summary",
    }));
    expect(invalidateHighlightDependentsMock).toHaveBeenCalledWith(expect.objectContaining({
      highlightId: "highlight-old",
    }));
    expect(startKnowledgeRefreshMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "knowledge-edit:highlight:highlight-new",
    }));
  });

  it("chooses revert behavior based on the recorded action", () => {
    expect(knowledgeRevertMode("retired")).toBe("restore_retired");
    expect(knowledgeRevertMode("revalidated")).toBe("restore_in_place");
    expect(knowledgeRevertMode("updated", { inPlace: true })).toBe("restore_in_place");
    expect(knowledgeRevertMode("updated")).toBe("retire_applied_revision");
    expect(knowledgeRevertMode("created")).toBe("retire_applied_revision");
  });

  it("reverting a retirement restores the entity instead of retiring it again", async () => {
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-retired",
      workItemId: "work-1",
      action: "retired",
      decision: "pending",
      beforeSnapshot: { id: "evidence-1", lifecycleStatus: "active", included: true },
      afterSnapshot: { id: "evidence-1", lifecycleStatus: "retired" },
      projectFact: null,
      highlight: null,
      evidenceItem: {
        id: "evidence-1",
        lifecycleStatus: "retired",
        included: false,
      },
      artifact: null,
      evidenceItemId: "evidence-1",
      projectFactId: null,
      highlightId: null,
      artifactId: null,
    });

    await resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-retired",
      decision: "revert",
    });

    expect(prismaMock.evidenceItem.update).toHaveBeenCalledWith({
      where: { id: "evidence-1" },
      data: expect.objectContaining({
        lifecycleStatus: "active",
        included: true,
        purgeEligibleAt: null,
      }),
    });
  });

  it("retires an outdated review card without mutating the newer canonical version", async () => {
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-old-head",
      workItemId: "work-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      action: "revalidated",
      decision: "pending",
      afterSnapshot: {
        id: "fact-1",
        lifecycleStatus: "active",
        validatedThroughSha: "sha-old",
      },
      projectFactId: "fact-1",
      projectFact: {
        id: "fact-1",
        lifecycleStatus: "active",
        validatedThroughSha: "sha-new",
        supersededByProjectFacts: [],
      },
      highlight: null,
      evidenceItem: null,
      artifact: null,
    });
    prismaMock.knowledgeChange.findFirst.mockResolvedValue({ id: "change-new-head" });

    const result = await resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-old-head",
      decision: "revert",
    });

    expect(result).toEqual({
      changeId: "change-old-head",
      decision: "retired",
      successor: null,
      superseded: true,
    });
    expect(prismaMock.projectFact.update).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenCalledWith({
      where: { id: "change-old-head", decision: "pending" },
      data: expect.objectContaining({ decision: "retired" }),
    });
  });

  it("restores the exact Project Fact evidence relation set when reverting in-place revalidation", async () => {
    const projectFact = {
      id: "fact-1",
      statement: "Durable workflows are persisted.",
      status: "approved",
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      validatedThroughSha: "sha-new",
      validationHeads: { "source-1": "sha-new" },
      supersededByProjectFacts: [],
    };
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-revalidated",
      workItemId: "work-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      action: "revalidated",
      decision: "pending",
      beforeSnapshot: {
        id: "fact-1",
        statement: projectFact.statement,
        status: "approved",
        lifecycleStatus: "needs_validation",
        reviewState: "reviewed",
        approvalSource: "user",
        validatedThroughSha: "sha-old",
        validationHeads: { "source-1": "sha-old" },
        lastValidatedAt: "2026-01-01T00:00:00.000Z",
        evidenceItemIds: ["evidence-old-1", "evidence-old-2"],
      },
      afterSnapshot: {
        id: "fact-1",
        statement: projectFact.statement,
        status: "approved",
        lifecycleStatus: "active",
        validatedThroughSha: "sha-new",
        evidenceItemIds: ["evidence-new"],
      },
      projectFactId: "fact-1",
      projectFact,
      highlight: null,
      evidenceItem: null,
      artifact: null,
    });
    const tx = {
      projectFact: { update: vi.fn().mockResolvedValue({}) },
      projectFactEvidence: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback(transactionClient(tx))
    );

    await resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-revalidated",
      decision: "revert",
    });

    expect(tx.projectFactEvidence.deleteMany).toHaveBeenCalledWith({
      where: { projectFactId: "fact-1" },
    });
    expect(tx.projectFactEvidence.createMany).toHaveBeenCalledWith({
      data: [
        { projectFactId: "fact-1", evidenceItemId: "evidence-old-1" },
        { projectFactId: "fact-1", evidenceItemId: "evidence-old-2" },
      ],
      skipDuplicates: true,
    });
    expect(tx.projectFact.update).toHaveBeenCalledWith({
      where: { id: "fact-1" },
      data: expect.objectContaining({
        lifecycleStatus: "needs_validation",
        reviewState: "reviewed",
        approvalSource: "user",
        validatedThroughSha: "sha-old",
      }),
    });
  });

  it("does not present unchanged Keep as a valid resolution for quarantined knowledge", async () => {
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-quarantined",
      workItemId: "work-1",
      createdAt: new Date(),
      action: "quarantined",
      decision: "pending",
      projectFactId: "fact-unsafe",
      projectFact: {
        id: "fact-unsafe",
        lifecycleStatus: "quarantined",
        supersededByProjectFacts: [],
      },
      highlight: null,
      evidenceItem: null,
      artifact: null,
    });

    await expect(resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-quarantined",
      decision: "keep",
    })).rejects.toThrow("Quarantined knowledge cannot be kept unchanged");

    expect(prismaMock.projectFact.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChange.update).not.toHaveBeenCalled();
  });

  it("returns the recorded immutable successor when an edit resolution is retried", async () => {
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-resolved",
      workItemId: "work-1",
      action: "updated",
      decision: "edited_and_kept",
      afterSnapshot: {
        id: "fact-old",
        reviewSuccessorId: "fact-new",
        reviewSuccessorKind: "project_fact",
      },
      projectFact: null,
      highlight: null,
      evidenceItem: null,
      artifact: null,
    });

    const result = await resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-resolved",
      decision: "edit_and_keep",
      patch: { statement: "Retried edit" },
    });

    expect(result).toEqual({
      changeId: "change-resolved",
      decision: "edited_and_kept",
      successor: { kind: "project_fact", id: "fact-new" },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(startKnowledgeRefreshMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "knowledge-edit:project_fact:fact-new",
    }));
  });

  it("serializes concurrent edit decisions so only one immutable successor is created", async () => {
    const projectFact = {
      id: "fact-old",
      statement: "Original assertion",
      category: "architecture",
      confidence: "high",
      status: "approved",
      sensitivityFlag: false,
      reviewNotes: null,
      subsystemKey: "runtime",
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      distinctiveness: 4,
      evidence: [],
      supersededByProjectFacts: [],
    };
    let current = {
      id: "change-concurrent",
      workItemId: "work-1",
      createdAt: new Date(),
      action: "updated",
      decision: "pending",
      beforeSnapshot: null,
      afterSnapshot: { id: "fact-old" },
      projectFactId: "fact-old",
      highlightId: null,
      evidenceItemId: null,
      artifactId: null,
      projectFact,
      highlight: null,
      evidenceItem: null,
      artifact: null,
    };
    let preflightReads = 0;
    let releasePreflights!: () => void;
    const bothPreflights = new Promise<void>((resolve) => { releasePreflights = resolve; });
    prismaMock.knowledgeChange.findFirstOrThrow.mockImplementation(async () => {
      if (preflightReads < 2) {
        preflightReads += 1;
        if (preflightReads === 2) releasePreflights();
        else await bothPreflights;
      }
      return { ...current, afterSnapshot: { ...current.afterSnapshot } };
    });
    prismaMock.knowledgeChange.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.decision !== "pending" || current.decision !== "pending") return { count: 0 };
      current = {
        ...current,
        decision: data.decision,
        afterSnapshot: data.afterSnapshot ?? current.afterSnapshot,
      };
      return { count: 1 };
    });
    const create = vi.fn().mockResolvedValue({
      ...projectFact,
      id: "fact-only-successor",
      statement: "Edited assertion",
      lifecycleStatus: "needs_validation",
    });
    const tx = transactionClient({
      projectFact: { create, update: vi.fn().mockResolvedValue({}) },
    });
    let tail = Promise.resolve();
    prismaMock.$transaction.mockImplementation(async (callback) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    });

    const [first, second] = await Promise.all([
      resolveKnowledgeChange({ userId: "user-1", changeId: current.id, decision: "edit_and_keep", patch: { statement: "Edited assertion" } }),
      resolveKnowledgeChange({ userId: "user-1", changeId: current.id, decision: "edit_and_keep", patch: { statement: "Different retry text" } }),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first.successor).toEqual({ kind: "project_fact", id: "fact-only-successor" });
    expect(second.successor).toEqual(first.successor);
  });

  it("returns durable success after post-commit failure and replays idempotent maintenance on retry", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.knowledgeChange.findFirstOrThrow.mockResolvedValue({
      id: "change-maintenance",
      workItemId: "work-1",
      action: "updated",
      decision: "edited_and_kept",
      beforeSnapshot: null,
      afterSnapshot: {
        id: "highlight-old",
        reviewSuccessorId: "highlight-new",
        reviewSuccessorKind: "highlight",
      },
      highlightId: "highlight-old",
      projectFactId: null,
      evidenceItemId: null,
      artifactId: null,
      projectFact: null,
      highlight: { id: "highlight-old", supersedesHighlightId: null },
      evidenceItem: null,
      artifact: null,
    });
    invalidateHighlightDependentsMock
      .mockRejectedValueOnce(new Error("temporary dependency failure"))
      .mockRejectedValueOnce(new Error("temporary dependency failure"))
      .mockResolvedValue([]);

    await expect(resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-maintenance",
      decision: "edit_and_keep",
    })).resolves.toMatchObject({ decision: "edited_and_kept" });
    await expect(resolveKnowledgeChange({
      userId: "user-1",
      changeId: "change-maintenance",
      decision: "edit_and_keep",
    })).resolves.toMatchObject({ decision: "edited_and_kept" });

    expect(invalidateHighlightDependentsMock).toHaveBeenCalledTimes(3);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rechecks relations under the Evidence row lock when an attachment races purge", async () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    let attached = false;
    let reads = 0;
    prismaMock.evidenceItem.findMany.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [{ id: "evidence-expired", workItemId: "work-1" }];
      return attached ? [] : [{ id: "evidence-expired" }];
    });
    prismaMock.evidenceItem.deleteMany.mockResolvedValue({ count: 1 });
    let lockCalls = 0;
    const tx = transactionClient({
      $queryRaw: vi.fn().mockImplementation(async () => {
        lockCalls += 1;
        if (lockCalls === 2) attached = true;
        return [{ locked: 1 }];
      }),
    });
    prismaMock.$transaction.mockImplementation(async (callback) => callback(tx));

    await expect(purgeExpiredUnreferencedEvidence(now)).resolves.toEqual([]);

    expect(lockCalls).toBe(2);
    expect(prismaMock.evidenceItem.deleteMany).not.toHaveBeenCalled();
  });
});
