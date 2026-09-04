import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  factEmbedding: vi.fn(),
  highlightEmbedding: vi.fn(),
  autoResolvedChanges: vi.fn(),
  reviewableChange: vi.fn(),
  reviewableChanges: vi.fn(),
}));

const transaction = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  knowledgeRefreshRun: {
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
  },
  projectFact: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn(),
  },
  highlight: {
    findFirst: vi.fn(),
    createMany: vi.fn(),
  },
  projectFactEvidence: { createMany: vi.fn(), deleteMany: vi.fn() },
  highlightEvidence: { createMany: vi.fn(), deleteMany: vi.fn() },
  highlightTag: { createMany: vi.fn() },
  evidenceItem: { updateMany: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  knowledgeRefreshRun: {
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
  },
  projectFact: { findMany: vi.fn() },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveActiveTextModelIdentity: () => ({ modelId: "test-model" }),
}));
vi.mock("@/src/services/knowledge-change-service", () => ({
  recordAutoResolvedKnowledgeChanges: vi.fn(),
  recordAutoResolvedKnowledgeChangesInTransaction: mocks.autoResolvedChanges,
  upsertReviewableKnowledgeChange: vi.fn(),
  upsertReviewableKnowledgeChangeInTransaction: mocks.reviewableChange,
  upsertReviewableKnowledgeChangesInTransaction: mocks.reviewableChanges,
}));
vi.mock("@/src/services/knowledge-embedding-service", () => ({
  buildProjectFactEmbeddingText: (input: { statement: string }) => `fact:${input.statement}`,
  upsertProjectFactEmbedding: mocks.factEmbedding,
}));
vi.mock("@/src/services/highlight-embedding-service", () => ({
  buildHighlightEmbeddingText: (input: { text: string }) => `highlight:${input.text}`,
  upsertHighlightEmbedding: mocks.highlightEmbedding,
}));
vi.mock("@/src/services/repository-knowledge-synthesis-service", () => ({
  materializeSynthesisCitations: vi.fn(),
  repositoryKnowledgeRole: (entry: {
    knowledgeRole?: string;
    implementationState?: string;
  }) => entry.knowledgeRole ??
    (entry.implementationState && entry.implementationState !== "implemented"
      ? "limitation"
      : "implementation"),
  synthesisNotebookReferenceKey: vi.fn(),
  synthesizeRepositoryKnowledge: vi.fn(),
}));

import {
  applyFact,
  createColdKnowledgeBatch,
  revalidateExistingKnowledge,
} from "@/src/services/knowledge-reconciliation-service";

const commitSha = "a".repeat(40);
const source = {
  sourceId: "source-1",
  repository: "owner/project",
  commitSha,
  blobSha: "b".repeat(40),
  path: "src/orders/service.ts",
  lineStart: 1,
  lineEnd: 20,
  statement: "The order service persists validated orders.",
  category: "data_flow" as const,
  confidence: "high" as const,
  sensitivityFlag: false,
  productImportance: 4,
  implementationBreadth: 3,
  technicalDifficulty: 3,
  changeType: "added" as const,
  semanticStatus: "succeeded" as const,
  evidenceMode: "semantic" as const,
  knowledgeRole: "implementation" as const,
  implementationState: "implemented" as const,
  operationKey: "orders.persist" as const,
  operationFacet: "persistence" as const,
};

const fact = (statement: string) => ({
  statement,
  category: "behavior" as const,
  confidence: "high" as const,
  sensitivityFlag: false,
  citationIndexes: [1],
  reviewNotes: "Verified from the repository.",
  productImportance: 4,
  implementationBreadth: 3,
  technicalDifficulty: 3,
  distinctiveness: 3,
});

const highlight = {
  text: "Validated order persistence",
  summary: "The order service persists validated orders.",
  confidence: "high" as const,
  sensitivityFlag: false,
  visibility: "public_safe" as const,
  citationIndexes: [1],
  productImportance: 4,
  implementationBreadth: 3,
  technicalDifficulty: 3,
  distinctiveness: 3,
};

function inputs() {
  const firstFact = fact("The order service persists validated orders.");
  const secondFact = fact("The query layer filters orders by an explicit status.");
  const subsystem = {
    sourceId: "source-1",
    repository: "owner/project",
    subsystemKey: "orders",
    synthesisKey: "orders#operation-persist",
    facts: [firstFact, secondFact],
    highlights: [highlight],
    unresolvedQuestions: [],
    coverageGaps: [],
    notebook: [source],
    tokenUsage: null,
    approvalEligible: true,
  };
  return {
    facts: [firstFact, secondFact].map((candidate, index) => ({
      key: `fact-${index + 1}`,
      subsystem,
      candidate,
      evidenceIds: index === 0 ? ["evidence-1", "evidence-shared"] : ["evidence-2"],
      commitSha,
      validationHeads: { "source-1": commitSha },
      sourceEntries: [source],
    })),
    highlights: [{
      key: "highlight-1",
      subsystem,
      candidate: highlight,
      evidenceIds: ["evidence-shared"],
      evidence: [{ title: "Order service", excerpt: source.statement, commitSha }],
      commitSha,
      validationHeads: { "source-1": commitSha },
      sourceEntries: [source],
    }],
  };
}

describe("cold repository knowledge batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.$queryRaw.mockResolvedValue([]);
    transaction.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-item-1",
      status: "reconciling",
      targetHeads: [{ sourceId: "source-1", commitSha, resolvedAt: "2026-08-29T10:00:00.000Z" }],
      createdAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    transaction.knowledgeRefreshRun.findMany.mockResolvedValue([]);
    transaction.projectFact.findFirst.mockResolvedValue(null);
    transaction.projectFact.updateMany.mockResolvedValue({ count: 1 });
    transaction.highlight.findFirst.mockResolvedValue(null);
    transaction.projectFact.createMany.mockImplementation(async ({ data }) => ({
      count: Array.isArray(data) ? data.length : 1,
    }));
    transaction.highlight.createMany.mockImplementation(async ({ data }) => ({
      count: Array.isArray(data) ? data.length : 1,
    }));
    transaction.projectFactEvidence.createMany.mockResolvedValue({ count: 3 });
    transaction.projectFactEvidence.deleteMany.mockResolvedValue({ count: 0 });
    transaction.highlightEvidence.createMany.mockResolvedValue({ count: 1 });
    transaction.highlightEvidence.deleteMany.mockResolvedValue({ count: 0 });
    transaction.highlightTag.createMany.mockResolvedValue({ count: 1 });
    transaction.evidenceItem.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-item-1",
      status: "reconciling",
      targetHeads: [{ sourceId: "source-1", commitSha, resolvedAt: "2026-08-29T10:00:00.000Z" }],
      createdAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([]);
    prismaMock.projectFact.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(async (operation) => operation(transaction));
    mocks.reviewableChanges.mockResolvedValue([]);
    mocks.reviewableChange.mockResolvedValue({ id: "change-1" });
    mocks.autoResolvedChanges.mockResolvedValue([]);
    mocks.factEmbedding.mockResolvedValue(undefined);
    mocks.highlightEmbedding.mockResolvedValue(undefined);
  });

  it("creates cold Facts and Highlights with the same evidence, audit, ownership, and embedding state", async () => {
    const queued: Array<{ entityKind: string; entityId: string; execute: () => Promise<unknown> }> = [];
    const prepared = inputs();
    let transactionCommitted = false;
    prismaMock.$transaction.mockImplementation(async (operation) => {
      const result = await operation(transaction);
      transactionCommitted = true;
      return result;
    });

    const result = await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      ...prepared,
      enqueueEmbedding: (task) => {
        expect(transactionCommitted).toBe(true);
        queued.push(task);
      },
    });

    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
    expect(transaction.projectFact.createMany).toHaveBeenCalledOnce();
    expect(transaction.highlight.createMany).toHaveBeenCalledOnce();
    const factRows = transaction.projectFact.createMany.mock.calls[0]![0].data;
    const highlightRows = transaction.highlight.createMany.mock.calls[0]![0].data;
    expect(factRows).toHaveLength(2);
    expect(factRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        statement: prepared.facts[0]!.candidate.statement,
        status: "approved",
        lifecycleStatus: "active",
        approvalSource: "automation",
        reviewState: "pending_review",
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: commitSha,
        subsystemKey: "orders",
        metadata: {
          schemaVersion: "repository-knowledge-metadata-v1",
          managedBy: "repository_knowledge_sync",
          refreshRunId: "refresh-1",
          sourceIds: ["source-1"],
          subsystemKey: "orders",
          synthesisKey: "orders#operation-persist",
          knowledgeRoles: ["implementation"],
          implementationStates: ["implemented"],
          operationKeys: ["orders.persist"],
          operationFacets: ["persistence"],
        },
      }),
      expect.objectContaining({ statement: prepared.facts[1]!.candidate.statement }),
    ]));
    expect(highlightRows).toEqual([
      expect.objectContaining({
        text: highlight.text,
        summary: highlight.summary,
        verificationStatus: "approved",
        lifecycleStatus: "active",
        approvalSource: "automation",
        visibility: "private",
        publicSafetyStatus: "failed",
        validatedThroughSha: commitSha,
        metadata: expect.objectContaining({
          schemaVersion: "repository-knowledge-metadata-v1",
          sourceIds: ["source-1"],
          synthesisKey: "orders#operation-persist",
          knowledgeRoles: ["implementation"],
          implementationStates: ["implemented"],
          operationKeys: ["orders.persist"],
          operationFacets: ["persistence"],
        }),
      }),
    ]);

    const factIds = result.createdFactIdsByKey;
    const highlightId = result.createdHighlightIdsByKey.get("highlight-1");
    expect(factIds.size).toBe(2);
    expect(highlightId).toEqual(expect.any(String));
    expect(transaction.projectFactEvidence.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { projectFactId: factIds.get("fact-1"), evidenceItemId: "evidence-1" },
        { projectFactId: factIds.get("fact-1"), evidenceItemId: "evidence-shared" },
        { projectFactId: factIds.get("fact-2"), evidenceItemId: "evidence-2" },
      ]),
      skipDuplicates: true,
    });
    expect(transaction.highlightEvidence.createMany).toHaveBeenCalledWith({
      data: [{ highlightId, evidenceItemId: "evidence-shared" }],
      skipDuplicates: true,
    });
    expect(transaction.highlightTag.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ highlightId })]),
      skipDuplicates: true,
    });
    expect(transaction.evidenceItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["evidence-1", "evidence-shared", "evidence-2"] } },
      data: { included: true },
    });

    const changes = mocks.reviewableChanges.mock.calls[0]![0];
    expect(mocks.reviewableChanges).toHaveBeenCalledWith(changes, transaction);
    expect(changes).toHaveLength(3);
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityKind: "project_fact",
        action: "created",
        entityId: factIds.get("fact-1"),
        reason: "Current repository evidence supported a new Project Fact.",
        policyVersion: "knowledge-lifecycle-v3",
        modelId: "test-model",
        provenance: expect.objectContaining({
          evidenceIds: ["evidence-1", "evidence-shared"],
          commitSha,
          subsystemKey: "orders",
          repositoryKnowledge: expect.objectContaining({
            implementationStates: ["implemented"],
            operationKeys: ["orders.persist"],
          }),
        }),
      }),
      expect.objectContaining({
        entityKind: "highlight",
        action: "created",
        entityId: highlightId,
        reason: "Current repository evidence supported a new Highlight.",
      }),
    ]));
    expect(queued.map(({ entityKind, entityId }) => ({ entityKind, entityId }))).toEqual([
      { entityKind: "project_fact", entityId: factIds.get("fact-1") },
      { entityKind: "project_fact", entityId: factIds.get("fact-2") },
      { entityKind: "highlight", entityId: highlightId },
    ]);
    expect(mocks.factEmbedding).not.toHaveBeenCalled();
    expect(mocks.highlightEmbedding).not.toHaveBeenCalled();

    await Promise.all(queued.map((task) => task.execute()));
    expect(mocks.factEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      projectFactId: factIds.get("fact-1"),
      inputText: `fact:${prepared.facts[0]!.candidate.statement}`,
      skipFreshnessCheck: true,
    }));
    expect(mocks.highlightEmbedding).toHaveBeenCalledWith({
      highlightId,
      inputText: `highlight:${highlight.text}`,
      skipFreshnessCheck: true,
    });
  });

  it("does not claim a cold batch when user-owned knowledge appears under the lock", async () => {
    transaction.projectFact.findFirst.mockResolvedValue({ id: "user-fact" });
    transaction.highlight.findFirst.mockResolvedValue({ id: "user-highlight" });
    const queued = vi.fn();

    const result = await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      ...inputs(),
      enqueueEmbedding: queued,
    });

    expect(result.createdFactIdsByKey.size).toBe(0);
    expect(result.createdHighlightIdsByKey.size).toBe(0);
    expect(transaction.projectFact.createMany).not.toHaveBeenCalled();
    expect(transaction.highlight.createMany).not.toHaveBeenCalled();
    expect(transaction.projectFactEvidence.createMany).not.toHaveBeenCalled();
    expect(transaction.highlightEvidence.createMany).not.toHaveBeenCalled();
    expect(transaction.highlightTag.createMany).not.toHaveBeenCalled();
    expect(transaction.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(mocks.reviewableChanges).not.toHaveBeenCalled();
    expect(queued).not.toHaveBeenCalled();
  });

  it("persists a partial limitation state from its exact cited source entries", async () => {
    const prepared = inputs();
    const partialSource = {
      ...source,
      statement: "Order persistence exists, but retry recovery is incomplete.",
      knowledgeRole: "limitation" as const,
      implementationState: "partial" as const,
      operationKey: "orders.retry_recovery",
      operationFacet: "boundary" as const,
    };
    const limitationFact = {
      ...prepared.facts[0]!,
      subsystem: {
        ...prepared.facts[0]!.subsystem,
        synthesisKey: "orders#limitation-retry-recovery",
        notebook: [partialSource],
      },
      sourceEntries: [partialSource],
    };

    await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [limitationFact],
      highlights: [],
      enqueueEmbedding: vi.fn(),
    });

    expect(transaction.projectFact.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        metadata: expect.objectContaining({
          synthesisKey: "orders#limitation-retry-recovery",
          knowledgeRoles: ["limitation"],
          implementationStates: ["partial"],
          operationKeys: ["orders.retry_recovery"],
          operationFacets: ["boundary"],
        }),
      })],
    }));
  });

  it("re-reads a user row after the cold check, preserves its wording, and stops on a lost CAS", async () => {
    transaction.projectFact.findFirst.mockResolvedValue({ id: "user-fact" });
    const prepared = inputs();
    const selectedAt = new Date("2026-08-29T10:00:01.000Z");
    const userStatement = `${prepared.facts[0]!.candidate.statement} indeed`;
    prismaMock.projectFact.findMany.mockResolvedValue([{
      id: "user-fact",
      workItemId: "work-item-1",
      subsystemKey: "orders",
      statement: userStatement,
      category: "behavior",
      confidence: "high",
      status: "approved",
      sensitivityFlag: false,
      lifecycleStatus: "needs_validation",
      reviewState: "reviewed",
      approvalSource: "user",
      publicSafetyStatus: "not_eligible",
      supersedesProjectFactId: null,
      updatedAt: selectedAt,
      validatedThroughSha: null,
      validationHeads: null,
      lastValidatedAt: null,
      autoAppliedAt: null,
      evidence: [],
    }]);

    const cold = await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [prepared.facts[0]!],
      highlights: [],
      enqueueEmbedding: vi.fn(),
    });
    expect(cold.createdFactIdsByKey.size).toBe(0);

    await expect(applyFact({
      runId: "refresh-1",
      workItemId: "work-item-1",
      ...prepared.facts[0]!,
      allowCanonicalReplacement: true,
      enqueueEmbedding: vi.fn(),
    })).resolves.toBe("user-fact");

    expect(prismaMock.projectFact.findMany).toHaveBeenCalledWith({
      where: {
        workItemId: "work-item-1",
        lifecycleStatus: { in: ["active", "needs_validation"] },
      },
      include: { evidence: { include: { evidenceItem: true } } },
    });
    expect(transaction.projectFact.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "user-fact",
        statement: userStatement,
        approvalSource: "user",
        updatedAt: selectedAt,
      }),
      data: expect.objectContaining({ reviewState: "reviewed" }),
    }));
    expect(transaction.projectFact.updateMany.mock.calls[0]![0].data)
      .not.toHaveProperty("statement");
    expect(transaction.projectFact.createMany).not.toHaveBeenCalled();
    expect(mocks.reviewableChange).not.toHaveBeenCalled();
    expect(mocks.autoResolvedChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        entityId: "user-fact",
        action: "revalidated",
        afterSnapshot: expect.objectContaining({ reviewState: "reviewed" }),
        reason: expect.stringContaining("user-edited Project Fact without replacing its wording"),
      }),
    ], transaction);

    transaction.projectFact.updateMany.mockResolvedValueOnce({ count: 0 });
    mocks.reviewableChange.mockClear();
    const enqueueEmbedding = vi.fn();
    await expect(applyFact({
      runId: "refresh-1",
      workItemId: "work-item-1",
      ...prepared.facts[0]!,
      allowCanonicalReplacement: true,
      enqueueEmbedding,
    })).resolves.toBeNull();
    expect(mocks.reviewableChange).not.toHaveBeenCalled();
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it("does not retain rolled-back IDs when a retry sees newly committed knowledge", async () => {
    const prepared = inputs();
    const queued = vi.fn();
    transaction.projectFact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "user-fact" });
    prismaMock.$transaction
      .mockImplementationOnce(async (operation) => {
        await operation(transaction);
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      })
      .mockImplementationOnce(async (operation) => operation(transaction));

    const result = await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [prepared.facts[0]!],
      highlights: [],
      enqueueEmbedding: queued,
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(transaction.projectFact.createMany).toHaveBeenCalledOnce();
    expect(result.createdFactIdsByKey.size).toBe(0);
    expect(queued).not.toHaveBeenCalled();
  });

  it("does not publish a rolled-back batched revalidation after a lost retry CAS", async () => {
    const prepared = inputs();
    const selectedAt = new Date("2026-08-29T10:00:01.000Z");
    const existingFact = {
      id: "existing-fact",
      workItemId: "work-item-1",
      subsystemKey: "orders",
      statement: prepared.facts[0]!.candidate.statement,
      category: "behavior",
      confidence: "high",
      status: "approved",
      sensitivityFlag: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      supersedesProjectFactId: null,
      updatedAt: selectedAt,
      validatedThroughSha: null,
      validationHeads: null,
      lastValidatedAt: null,
      autoAppliedAt: null,
      evidence: [],
    };
    transaction.projectFact.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prismaMock.$transaction
      .mockImplementationOnce(async (operation) => {
        await operation(transaction);
        transaction.projectFactEvidence.deleteMany.mockClear();
        transaction.projectFactEvidence.createMany.mockClear();
        transaction.evidenceItem.updateMany.mockClear();
        mocks.autoResolvedChanges.mockClear();
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      })
      .mockImplementationOnce(async (operation) => operation(transaction));

    const result = await revalidateExistingKnowledge({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [prepared.facts[0]!],
      highlights: [],
      existingFacts: [existingFact as never],
      existingHighlights: [],
    });

    expect(result.matchedKeys).toEqual(new Set(["fact-1"]));
    expect(result.appliedFactIdsByKey.size).toBe(0);
    expect(transaction.projectFactEvidence.deleteMany).not.toHaveBeenCalled();
    expect(transaction.projectFactEvidence.createMany).not.toHaveBeenCalled();
    expect(transaction.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(mocks.autoResolvedChanges).not.toHaveBeenCalled();
  });

  it("publishes only the committed batched revalidation retry", async () => {
    const prepared = inputs();
    const existingFact = {
      id: "existing-fact",
      workItemId: "work-item-1",
      subsystemKey: "orders",
      statement: prepared.facts[0]!.candidate.statement,
      status: "approved",
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      supersedesProjectFactId: null,
      updatedAt: new Date("2026-08-29T10:00:01.000Z"),
      validatedThroughSha: null,
      evidence: [],
    };
    transaction.projectFact.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction
      .mockImplementationOnce(async (operation) => {
        await operation(transaction);
        transaction.projectFactEvidence.deleteMany.mockClear();
        transaction.projectFactEvidence.createMany.mockClear();
        transaction.evidenceItem.updateMany.mockClear();
        mocks.autoResolvedChanges.mockClear();
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      })
      .mockImplementationOnce(async (operation) => operation(transaction));

    const result = await revalidateExistingKnowledge({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [prepared.facts[0]!],
      highlights: [],
      existingFacts: [existingFact as never],
      existingHighlights: [],
    });

    expect(result.appliedFactIdsByKey).toEqual(new Map([
      ["fact-1", "existing-fact"],
    ]));
    expect(transaction.projectFactEvidence.deleteMany).toHaveBeenCalledOnce();
    expect(transaction.projectFactEvidence.createMany).toHaveBeenCalledOnce();
    expect(transaction.evidenceItem.updateMany).toHaveBeenCalledOnce();
    expect(mocks.autoResolvedChanges).toHaveBeenCalledOnce();
  });

  it("preserves review ownership during automatic unchanged-text revalidation", async () => {
    const prepared = inputs();
    const previousMetadata = {
      schemaVersion: "repository-knowledge-metadata-v1",
      managedBy: "repository_knowledge_sync",
      refreshRunId: "refresh-old",
      sourceIds: ["source-1"],
      subsystemKey: "orders",
      synthesisKey: "orders#operation-persist",
      knowledgeRoles: ["implementation"],
      implementationStates: ["implemented"],
      operationKeys: ["orders.persist"],
      operationFacets: ["persistence"],
    };
    const existingFact = {
      id: "reviewed-user-fact",
      workItemId: "work-item-1",
      subsystemKey: "orders",
      statement: prepared.facts[0]!.candidate.statement,
      status: "approved",
      lifecycleStatus: "needs_validation",
      reviewState: "reviewed",
      approvalSource: "user",
      supersedesProjectFactId: null,
      metadata: previousMetadata,
      updatedAt: new Date("2026-08-29T10:00:01.000Z"),
      validatedThroughSha: null,
      evidence: [],
    };

    const result = await revalidateExistingKnowledge({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [prepared.facts[0]!],
      highlights: [],
      existingFacts: [existingFact as never],
      existingHighlights: [],
    });

    expect(result.appliedFactIdsByKey.get("fact-1")).toBe("reviewed-user-fact");
    expect(transaction.projectFact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          metadata: { equals: previousMetadata },
        }),
        data: expect.objectContaining({
          reviewState: "reviewed",
          metadata: expect.objectContaining({
            refreshRunId: "refresh-1",
            sourceIds: ["source-1"],
            synthesisKey: "orders#operation-persist",
            knowledgeRoles: ["implementation"],
            implementationStates: ["implemented"],
            operationKeys: ["orders.persist"],
            operationFacets: ["persistence"],
          }),
        }),
      }),
    );
    expect(mocks.autoResolvedChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        entityId: "reviewed-user-fact",
        beforeSnapshot: expect.objectContaining({
          reviewState: "reviewed",
          approvalSource: "user",
        }),
        afterSnapshot: expect.objectContaining({
          reviewState: "reviewed",
          approvalSource: "user",
        }),
      }),
    ], transaction);
  });

  it("does not revalidate a same-text claim when its explicit operation state changed", async () => {
    const prepared = inputs();
    const existingFact = {
      id: "planned-user-fact",
      workItemId: "work-item-1",
      subsystemKey: "orders",
      statement: prepared.facts[0]!.candidate.statement,
      status: "approved",
      lifecycleStatus: "needs_validation",
      reviewState: "reviewed",
      approvalSource: "user",
      supersedesProjectFactId: null,
      metadata: {
        schemaVersion: "repository-knowledge-metadata-v1",
        managedBy: "repository_knowledge_sync",
        refreshRunId: "refresh-old",
        sourceIds: ["source-1"],
        subsystemKey: "orders",
        synthesisKey: "orders#operation-persist",
        knowledgeRoles: ["limitation"],
        implementationStates: ["planned"],
        operationKeys: ["orders.persist"],
        operationFacets: ["boundary"],
      },
      updatedAt: new Date("2026-08-29T10:00:01.000Z"),
      validatedThroughSha: null,
      evidence: [],
    };

    const result = await revalidateExistingKnowledge({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts: [prepared.facts[0]!],
      highlights: [],
      existingFacts: [existingFact as never],
      existingHighlights: [],
    });

    expect(result.matchedKeys).toEqual(new Set());
    expect(result.appliedFactIdsByKey.size).toBe(0);
    expect(transaction.projectFact.updateMany).not.toHaveBeenCalled();
    expect(mocks.autoResolvedChanges).not.toHaveBeenCalled();
  });

  it("keeps audit identities distinct for identical claims in different scopes", async () => {
    const prepared = inputs();
    const secondSubsystem = {
      ...prepared.facts[0]!.subsystem,
      sourceId: "source-2",
      subsystemKey: "billing",
    };
    const facts = [
      prepared.facts[0]!,
      {
        ...prepared.facts[0]!,
        key: "fact-other-scope",
        subsystem: secondSubsystem,
        evidenceIds: ["evidence-2"],
      },
    ];
    const highlights = [
      prepared.highlights[0]!,
      {
        ...prepared.highlights[0]!,
        key: "highlight-other-scope",
        subsystem: secondSubsystem,
        evidenceIds: ["evidence-2"],
      },
    ];

    const result = await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      facts,
      highlights,
      enqueueEmbedding: vi.fn(),
    });

    expect(result.createdFactIdsByKey.size).toBe(2);
    expect(result.createdHighlightIdsByKey.size).toBe(2);
    const changes = mocks.reviewableChanges.mock.calls[0]![0];
    expect(changes).toHaveLength(4);
    expect(new Set(changes.map((change: { idempotencyKey: string }) =>
      change.idempotencyKey
    )).size).toBe(4);
    expect(new Set(changes.map((change: { entityId: string }) =>
      change.entityId
    ))).toEqual(new Set([
      ...result.createdFactIdsByKey.values(),
      ...result.createdHighlightIdsByKey.values(),
    ]));
  });

  it("leaves identity-colliding candidates on the existing per-row path", async () => {
    const prepared = inputs();
    prepared.facts[1] = {
      ...prepared.facts[1]!,
      candidate: fact("The order service persists validated orders."),
    };

    const result = await createColdKnowledgeBatch({
      runId: "refresh-1",
      workItemId: "work-item-1",
      ...prepared,
      highlights: [],
      enqueueEmbedding: vi.fn(),
    });

    expect(result.createdFactIdsByKey.size).toBe(0);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(transaction.projectFact.createMany).not.toHaveBeenCalled();
    expect(mocks.reviewableChanges).not.toHaveBeenCalled();
  });
});
