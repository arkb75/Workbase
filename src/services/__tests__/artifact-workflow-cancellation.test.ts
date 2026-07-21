import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildArtifact: vi.fn(),
  verifyArtifact: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  queryActiveRun: vi.fn(),
  upsertArtifact: vi.fn(),
  findRun: vi.fn(),
  findActiveRun: vi.fn(),
  loadContext: vi.fn(),
  findHighlights: vi.fn(),
  findEvidence: vi.fn(),
  research: vi.fn(),
  promote: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateHighlights: vi.fn(),
  verifyHighlights: vi.fn(),
  upsertHighlightEmbedding: vi.fn(),
  recordChange: vi.fn(),
  updateEvidence: vi.fn(),
  findPendingCandidates: vi.fn(),
  findBatchCandidates: vi.fn(),
  createCandidate: vi.fn(),
  createHighlight: vi.fn(),
  updateHighlight: vi.fn(),
  createHighlightEvidence: vi.fn(),
  createHighlightTags: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    agentRun: {
      findUniqueOrThrow: mocks.findRun,
      findFirst: mocks.findActiveRun,
    },
    agentRunCandidate: { findMany: mocks.findPendingCandidates },
    workItem: { findFirstOrThrow: mocks.loadContext },
    highlight: { findMany: mocks.findHighlights },
    evidenceItem: {
      findMany: mocks.findEvidence,
      updateMany: mocks.updateEvidence,
    },
    artifact: {
      upsert: mocks.upsertArtifact,
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (
      callback: (tx: {
        $queryRaw: typeof mocks.queryActiveRun;
        artifact: { upsert: typeof mocks.upsertArtifact };
        agentRunCandidate: {
          findMany: typeof mocks.findBatchCandidates;
          create: typeof mocks.createCandidate;
        };
        highlight: {
          create: typeof mocks.createHighlight;
          update: typeof mocks.updateHighlight;
        };
        highlightEvidence: { createMany: typeof mocks.createHighlightEvidence };
        highlightTag: { createMany: typeof mocks.createHighlightTags };
        evidenceItem: { updateMany: typeof mocks.updateEvidence };
      }) => Promise<unknown>,
    ) => callback({
      $queryRaw: mocks.queryActiveRun,
      artifact: { upsert: mocks.upsertArtifact },
      agentRunCandidate: {
        findMany: mocks.findBatchCandidates,
        create: mocks.createCandidate,
      },
      highlight: {
        create: mocks.createHighlight,
        update: mocks.updateHighlight,
      },
      highlightEvidence: { createMany: mocks.createHighlightEvidence },
      highlightTag: { createMany: mocks.createHighlightTags },
      evidenceItem: { updateMany: mocks.updateEvidence },
    })),
  },
}));

vi.mock("@/src/domain/workbase-workflows", () => ({
  buildArtifactFromApprovedClaims: mocks.buildArtifact,
}));

vi.mock("@/src/services/public-knowledge-verification-service", () => ({
  publicKnowledgeVerificationService: {
    verify: vi.fn(async () => ({
      eligible: true,
      correctedText: null,
      reasons: [],
      claimChecks: [],
      tokenUsage: null,
    })),
    verifyArtifact: mocks.verifyArtifact,
  },
}));

vi.mock("@/src/services/project-chat-store", () => ({
  appendAgentRunEvent: vi.fn(),
  completeAgentRun: mocks.completeRun,
  failAgentRun: mocks.failRun,
}));

vi.mock("@/src/services/knowledge-embedding-service", () => ({
  buildArtifactEmbeddingText: vi.fn(() => "artifact embedding"),
  upsertArtifactEmbedding: vi.fn(),
}));

vi.mock("@/src/services/highlight-embedding-service", () => ({
  buildHighlightEmbeddingText: vi.fn(() => "highlight embedding"),
  upsertHighlightEmbedding: mocks.upsertHighlightEmbedding,
}));

vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  recordChange: mocks.recordChange,
}));

vi.mock("@/src/services/project-research-service", () => ({
  projectResearchService: { research: mocks.research },
}));

vi.mock("@/src/services/repository-evidence-promotion-service", () => ({
  promoteRepositoryCitations: mocks.promote,
}));

vi.mock("@/src/services/project-knowledge-retrieval-service", () => ({
  projectKnowledgeRetrievalService: { retrieve: mocks.retrieveKnowledge },
}));

vi.mock("@/src/services/claim-research-service", () => ({
  claimResearchService: { generate: mocks.generateHighlights },
}));

vi.mock("@/src/services/claim-verification-service", () => ({
  claimVerificationService: { verify: mocks.verifyHighlights },
}));

import { executeArtifactAttempt } from "@/src/services/artifact-workflow-service";

function repositoryCitation(path: string, blobMarker: string) {
  return {
    kind: "github_file" as const,
    label: path,
    excerpt: `export const ${blobMarker} = true;`,
    sourceId: "source-1",
    repository: "workbase/demo",
    commitSha: "a".repeat(40),
    blobSha: blobMarker.repeat(40).slice(0, 40),
    path,
    startLine: 1,
    endLine: 1,
  };
}

function repositoryDraft(temporaryEvidenceId: string, marker: string) {
  return {
    text: `Implemented the ${marker} repository capability.`,
    summary: `${marker} repository capability.`,
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    visibility: "public_safe",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: "The exact excerpt supports this statement.",
    metadata: null,
    evidence: {
      summary: "The repository file directly supports this statement.",
      verificationNotes: "Complete source support.",
      sourceRefs: [{
        evidenceItemId: temporaryEvidenceId,
        sourceId: "source-1",
        sourceLabel: "workbase/demo",
        sourceType: "github_repo",
        title: `src/${marker}.ts`,
        excerpt: `export const ${marker} = true;`,
      }],
    },
    tags: [],
  };
}

describe("artifact cancellation during public verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryActiveRun.mockReset();
    mocks.findRun.mockResolvedValue({
      id: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
      status: "running",
      request: { brief: "Write a concise project summary." },
      candidates: [],
      artifact: null,
    });
    mocks.loadContext.mockResolvedValue({
      id: "work-item-1",
      userId: "user-1",
      title: "Workbase",
      type: "project",
      description: "Verified career-content project.",
      startDate: null,
      endDate: null,
      sources: [],
      evidenceItems: [],
      highlights: [],
    });
    mocks.buildArtifact.mockResolvedValue({
      artifactDraft: {
        content: "A grounded project summary.",
        usedHighlightIds: [],
        supportingEvidenceItemIds: [],
      },
      generationRunId: null,
      retrieval: {
        generationRunId: null,
        highlights: [],
        supportingEvidence: [],
      },
    });
    mocks.findHighlights.mockResolvedValue([]);
    mocks.findEvidence.mockResolvedValue([]);
    mocks.findActiveRun.mockResolvedValue({ id: "run-1" });
    mocks.verifyArtifact.mockResolvedValue({
      eligible: true,
      correctedContent: null,
      reasons: [],
    });
    // The cancellation commits while the provider verification is in flight.
    // The post-verification row lock therefore finds no active owner.
    mocks.queryActiveRun.mockResolvedValue([]);
    mocks.retrieveKnowledge.mockResolvedValue({
      hits: [],
      selectedEvidenceItemIds: [],
      warnings: [],
    });
    mocks.upsertHighlightEmbedding.mockResolvedValue(undefined);
    mocks.recordChange.mockResolvedValue(undefined);
    mocks.updateEvidence.mockResolvedValue({ count: 0 });
    mocks.findPendingCandidates.mockResolvedValue([]);
    mocks.findBatchCandidates.mockResolvedValue([]);
    mocks.createCandidate.mockResolvedValue({
      id: "candidate-1",
      highlightId: "highlight-1",
    });
    mocks.createHighlight.mockResolvedValue({ id: "highlight-1" });
    mocks.updateHighlight.mockResolvedValue({ id: "highlight-1" });
    mocks.createHighlightEvidence.mockResolvedValue({ count: 1 });
    mocks.createHighlightTags.mockResolvedValue({ count: 0 });
    mocks.promote.mockImplementation(async (input: {
      mutationFence?: <T>(operation: (tx: unknown) => Promise<T>) => Promise<T>;
    }) => {
      const result = {
        promotedIds: ["evidence-1"],
        newIds: ["evidence-1"],
        evidenceIdByCitationIndex: new Map([[0, "evidence-1"]]),
      };
      return input.mutationFence
        ? input.mutationFence(async () => result)
        : result;
    });
  });

  it("does not materialize or complete an Artifact after cancellation wins", async () => {
    await expect(executeArtifactAttempt({
      runId: "run-1",
      batchNumber: 1,
    })).rejects.toThrow("artifact run is no longer active");

    expect(mocks.verifyArtifact).toHaveBeenCalledOnce();
    expect(mocks.upsertArtifact).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.failRun).not.toHaveBeenCalled();
  });

  it("does not promote excerpts or materialize Highlights after cancellation wins during repository research", async () => {
    mocks.buildArtifact.mockResolvedValueOnce({
      artifactDraft: null,
      generationRunId: null,
      retrieval: {
        generationRunId: null,
        highlights: [],
        supportingEvidence: [],
      },
    });
    let finishResearch!: (value: {
      citations: Array<{
        kind: "github_file";
        label: string;
        excerpt: string;
        sourceId: string;
        repository: string;
        commitSha: string;
        blobSha: string;
        path: string;
        startLine: number;
        endLine: number;
      }>;
    }) => void;
    let researchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      researchStarted = resolve;
    });
    mocks.research.mockImplementationOnce(async () => {
      researchStarted();
      return new Promise((resolve) => {
        finishResearch = resolve;
      });
    });
    const temporaryEvidenceId = "artifact-research:run-1:1:0";
    const draft = {
      text: "Implemented a cancellation-safe artifact research pipeline.",
      summary: "Cancellation-safe artifact research.",
      confidence: "high",
      ownershipClarity: "clear",
      sensitivityFlag: false,
      verificationStatus: "approved",
      visibility: "public",
      risksSummary: null,
      missingInfo: null,
      rejectionReason: null,
      verificationNotes: "Supported by the cited implementation.",
      metadata: null,
      evidence: {
        summary: "The repository excerpt shows the research pipeline.",
        verificationNotes: "Direct repository evidence.",
        sourceRefs: [{
          evidenceItemId: temporaryEvidenceId,
          sourceId: "source-1",
          sourceLabel: "workbase/demo",
          sourceType: "github_repo",
          title: "src/services/artifact-workflow-service.ts",
          excerpt: "async function generateCandidateBatch() {}",
        }],
      },
      tags: [],
    };
    mocks.generateHighlights.mockResolvedValueOnce({
      highlights: [draft],
      generationRunIds: { generation: [], verification: null },
    });
    mocks.verifyHighlights.mockResolvedValueOnce([draft]);

    const attempt = executeArtifactAttempt({
      runId: "run-1",
      batchNumber: 1,
    });
    await started;
    finishResearch({
      citations: [{
        kind: "github_file",
        label: "src/services/artifact-workflow-service.ts",
        excerpt: "async function generateCandidateBatch() {}",
        sourceId: "source-1",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        blobSha: "b".repeat(40),
        path: "src/services/artifact-workflow-service.ts",
        startLine: 381,
        endLine: 620,
      }],
    });

    await expect(attempt).rejects.toThrow("artifact run is no longer active");
    expect(mocks.generateHighlights).toHaveBeenCalledOnce();
    expect(mocks.verifyHighlights).toHaveBeenCalledOnce();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.upsertHighlightEmbedding).not.toHaveBeenCalled();
    expect(mocks.recordChange).not.toHaveBeenCalled();
    expect(mocks.updateEvidence).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.failRun).not.toHaveBeenCalled();
  });

  it("omits a partially promoted draft while retaining an independently grounded draft", async () => {
    mocks.queryActiveRun
      .mockResolvedValueOnce([{ id: "run-1" }])
      .mockResolvedValueOnce([
        {
          id: "evidence-2",
          included: false,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
        },
        {
          id: "evidence-3",
          included: false,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
        },
      ])
      .mockResolvedValueOnce([{
        id: "evidence-3",
        included: true,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }]);
    mocks.updateEvidence.mockResolvedValueOnce({ count: 1 });
    mocks.buildArtifact.mockResolvedValueOnce({
      artifactDraft: null,
      generationRunId: null,
      retrieval: {
        generationRunId: null,
        highlights: [],
        supportingEvidence: [],
      },
    });
    mocks.research.mockResolvedValueOnce({
      citations: [
        {
          kind: "github_file",
          label: "src/first.ts",
          excerpt: "export const first = true;",
          sourceId: "source-1",
          repository: "workbase/demo",
          commitSha: "a".repeat(40),
          blobSha: "b".repeat(40),
          path: "src/first.ts",
          startLine: 1,
          endLine: 1,
        },
        {
          kind: "github_file",
          label: "src/second.ts",
          excerpt: "export const second = true;",
          sourceId: "source-1",
          repository: "workbase/demo",
          commitSha: "a".repeat(40),
          blobSha: "c".repeat(40),
          path: "src/second.ts",
          startLine: 1,
          endLine: 1,
        },
        {
          kind: "github_file",
          label: "src/independent.ts",
          excerpt: "export const independent = true;",
          sourceId: "source-1",
          repository: "workbase/demo",
          commitSha: "a".repeat(40),
          blobSha: "d".repeat(40),
          path: "src/independent.ts",
          startLine: 1,
          endLine: 1,
        },
      ],
    });
    const partialDraft = {
      text: "Coordinated the first and second modules as one combined feature.",
      summary: "Combined first-and-second feature.",
      confidence: "high",
      ownershipClarity: "clear",
      sensitivityFlag: false,
      verificationStatus: "approved",
      visibility: "public",
      risksSummary: null,
      missingInfo: null,
      rejectionReason: null,
      verificationNotes: "Both excerpts are required.",
      metadata: null,
      evidence: {
        summary: "Both files jointly support this statement.",
        verificationNotes: "Complete two-source support required.",
        sourceRefs: [0, 1].map((index) => ({
          evidenceItemId: `artifact-research:run-1:1:${index}`,
          sourceId: "source-1",
          sourceLabel: "workbase/demo",
          sourceType: "github_repo",
          title: index === 0 ? "src/first.ts" : "src/second.ts",
          excerpt: index === 0
            ? "export const first = true;"
            : "export const second = true;",
        })),
      },
      tags: [],
    };
    const independentDraft = {
      ...partialDraft,
      text: "Added a standalone independent export for a separate execution mode.",
      summary: "Standalone independent export.",
      verificationNotes: "The independent excerpt is complete support.",
      evidence: {
        summary: "One independently promoted file supports this statement.",
        verificationNotes: "Complete independent support.",
        sourceRefs: [{
          evidenceItemId: "artifact-research:run-1:1:2",
          sourceId: "source-1",
          sourceLabel: "workbase/demo",
          sourceType: "github_repo",
          title: "src/independent.ts",
          excerpt: "export const independent = true;",
        }],
      },
    };
    mocks.generateHighlights.mockResolvedValueOnce({
      highlights: [partialDraft, independentDraft],
      generationRunIds: { generation: [], verification: null },
    });
    mocks.verifyHighlights.mockResolvedValueOnce([partialDraft, independentDraft]);
    mocks.promote.mockImplementationOnce(async (input: {
      mutationFence?: <T>(operation: (tx: unknown) => Promise<T>) => Promise<T>;
    }) => {
      const partial = {
        promotedIds: ["evidence-2", "evidence-3"],
        newIds: ["evidence-2", "evidence-3"],
        evidenceIdByCitationIndex: new Map([
          [1, "evidence-2"],
          [2, "evidence-3"],
        ]),
      };
      return input.mutationFence
        ? input.mutationFence(async () => partial)
        : partial;
    });

    const result = await executeArtifactAttempt({
      runId: "run-1",
      batchNumber: 1,
    });

    expect(result).toEqual({ status: "retry_research", batchNumber: 2 });
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({
      mutationFence: expect.any(Function),
    }));
    expect(mocks.createHighlight).toHaveBeenCalledOnce();
    expect(mocks.createCandidate).toHaveBeenCalledOnce();
    expect(mocks.updateHighlight).toHaveBeenCalledOnce();
    expect(mocks.createHighlightEvidence).toHaveBeenCalledWith({
      data: [{
        highlightId: "highlight-1",
        evidenceItemId: "evidence-3",
        relevanceScore: null,
      }],
      skipDuplicates: true,
    });
    expect(mocks.updateEvidence).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["evidence-3"] } }),
      data: { included: true },
    }));
    expect(mocks.upsertHighlightEmbedding).toHaveBeenCalledOnce();
    expect(mocks.recordChange).toHaveBeenCalledOnce();
  });

  it("atomically promotes and remaps complete repository evidence before materializing a Highlight", async () => {
    mocks.queryActiveRun
      .mockResolvedValueOnce([{ id: "run-1" }])
      .mockResolvedValueOnce([{
        id: "evidence-1",
        included: false,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }])
      .mockResolvedValueOnce([{
        id: "evidence-1",
        included: true,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }]);
    mocks.updateEvidence.mockResolvedValueOnce({ count: 1 });
    mocks.buildArtifact.mockResolvedValueOnce({
      artifactDraft: null,
      generationRunId: null,
      retrieval: {
        generationRunId: null,
        highlights: [],
        supportingEvidence: [],
      },
    });
    mocks.research.mockResolvedValueOnce({
      citations: [{
        kind: "github_file",
        label: "src/complete.ts",
        excerpt: "export const complete = true;",
        sourceId: "source-1",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        blobSha: "b".repeat(40),
        path: "src/complete.ts",
        startLine: 1,
        endLine: 1,
      }],
    });
    const draft = {
      text: "Implemented a completely grounded repository capability.",
      summary: "Completely grounded capability.",
      confidence: "high",
      ownershipClarity: "clear",
      sensitivityFlag: false,
      verificationStatus: "approved",
      visibility: "public",
      risksSummary: null,
      missingInfo: null,
      rejectionReason: null,
      verificationNotes: "The exact excerpt supports this statement.",
      metadata: null,
      evidence: {
        summary: "The repository file directly supports this statement.",
        verificationNotes: "Complete source support.",
        sourceRefs: [{
          evidenceItemId: "artifact-research:run-1:1:0",
          sourceId: "source-1",
          sourceLabel: "workbase/demo",
          sourceType: "github_repo",
          title: "src/complete.ts",
          excerpt: "export const complete = true;",
        }],
      },
      tags: [],
    };
    mocks.generateHighlights.mockResolvedValueOnce({
      highlights: [draft],
      generationRunIds: { generation: [], verification: null },
    });
    mocks.verifyHighlights.mockResolvedValueOnce([draft]);

    const result = await executeArtifactAttempt({
      runId: "run-1",
      batchNumber: 1,
    });

    expect(result).toEqual({ status: "retry_research", batchNumber: 2 });
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({
      mutationFence: expect.any(Function),
    }));
    expect(mocks.createHighlight).toHaveBeenCalledOnce();
    expect(mocks.createHighlightEvidence).toHaveBeenCalledWith({
      data: [{
        highlightId: "highlight-1",
        evidenceItemId: "evidence-1",
        relevanceScore: null,
      }],
      skipDuplicates: true,
    });
    expect(mocks.createCandidate).toHaveBeenCalledOnce();
    expect(mocks.updateHighlight).toHaveBeenCalledOnce();
    expect(mocks.updateEvidence).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["evidence-1"] } }),
      data: { included: true },
    }));
    expect(mocks.upsertHighlightEmbedding).toHaveBeenCalledOnce();
    expect(mocks.recordChange).toHaveBeenCalledOnce();
  });

  it("honors a user-excluded reused excerpt while preserving an independently grounded draft", async () => {
    mocks.queryActiveRun
      .mockResolvedValueOnce([{ id: "run-1" }])
      .mockResolvedValueOnce([
        {
          id: "evidence-user-excluded",
          included: false,
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
        },
        {
          id: "evidence-automation",
          included: false,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
        },
      ])
      .mockResolvedValueOnce([{
        id: "evidence-automation",
        included: true,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }]);
    mocks.updateEvidence.mockResolvedValueOnce({ count: 1 });
    mocks.buildArtifact.mockResolvedValueOnce({
      artifactDraft: null,
      generationRunId: null,
      retrieval: { generationRunId: null, highlights: [], supportingEvidence: [] },
    });
    mocks.research.mockResolvedValueOnce({
      citations: [
        repositoryCitation("src/user-excluded.ts", "b"),
        repositoryCitation("src/automation.ts", "c"),
      ],
    });
    const excludedDraft = repositoryDraft("artifact-research:run-1:1:0", "userExcluded");
    const independentDraft = repositoryDraft("artifact-research:run-1:1:1", "automation");
    mocks.generateHighlights.mockResolvedValueOnce({
      highlights: [excludedDraft, independentDraft],
      generationRunIds: { generation: [], verification: null },
    });
    mocks.verifyHighlights.mockResolvedValueOnce([excludedDraft, independentDraft]);
    mocks.promote.mockImplementationOnce(async (input: {
      mutationFence?: <T>(operation: (tx: unknown) => Promise<T>) => Promise<T>;
    }) => {
      const promoted = {
        promotedIds: ["evidence-user-excluded", "evidence-automation"],
        newIds: [],
        evidenceIdByCitationIndex: new Map([
          [0, "evidence-user-excluded"],
          [1, "evidence-automation"],
        ]),
      };
      return input.mutationFence
        ? input.mutationFence(async () => promoted)
        : promoted;
    });

    const result = await executeArtifactAttempt({ runId: "run-1", batchNumber: 1 });

    expect(result).toEqual({ status: "retry_research", batchNumber: 2 });
    expect(mocks.createHighlight).toHaveBeenCalledOnce();
    expect(mocks.createHighlightEvidence).toHaveBeenCalledWith({
      data: [{
        highlightId: "highlight-1",
        evidenceItemId: "evidence-automation",
        relevanceScore: null,
      }],
      skipDuplicates: true,
    });
    expect(mocks.updateEvidence).toHaveBeenCalledOnce();
    expect(mocks.updateEvidence).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["evidence-automation"] } }),
      data: { included: true },
    }));
    expect(mocks.updateEvidence).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["evidence-user-excluded"] } }),
    }));
  });

  it("auto-includes an automation-pending reused excerpt before creating its Highlight", async () => {
    mocks.queryActiveRun
      .mockResolvedValueOnce([{ id: "run-1" }])
      .mockResolvedValueOnce([{
        id: "evidence-reused",
        included: false,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }])
      .mockResolvedValueOnce([{
        id: "evidence-reused",
        included: true,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }]);
    mocks.updateEvidence.mockResolvedValueOnce({ count: 1 });
    mocks.buildArtifact.mockResolvedValueOnce({
      artifactDraft: null,
      generationRunId: null,
      retrieval: { generationRunId: null, highlights: [], supportingEvidence: [] },
    });
    mocks.research.mockResolvedValueOnce({
      citations: [repositoryCitation("src/reused.ts", "d")],
    });
    const draft = repositoryDraft("artifact-research:run-1:1:0", "reused");
    mocks.generateHighlights.mockResolvedValueOnce({
      highlights: [draft],
      generationRunIds: { generation: [], verification: null },
    });
    mocks.verifyHighlights.mockResolvedValueOnce([draft]);
    mocks.promote.mockImplementationOnce(async (input: {
      mutationFence?: <T>(operation: (tx: unknown) => Promise<T>) => Promise<T>;
    }) => {
      const promoted = {
        promotedIds: ["evidence-reused"],
        newIds: [],
        evidenceIdByCitationIndex: new Map([[0, "evidence-reused"]]),
      };
      return input.mutationFence
        ? input.mutationFence(async () => promoted)
        : promoted;
    });

    const result = await executeArtifactAttempt({ runId: "run-1", batchNumber: 1 });

    expect(result).toEqual({ status: "retry_research", batchNumber: 2 });
    expect(mocks.updateEvidence).toHaveBeenCalledWith({
      where: {
        id: { in: ["evidence-reused"] },
        workItemId: "work-item-1",
        included: false,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      },
      data: { included: true },
    });
    expect(mocks.createHighlight).toHaveBeenCalledOnce();
    expect(mocks.createHighlightEvidence).toHaveBeenCalledWith({
      data: [{
        highlightId: "highlight-1",
        evidenceItemId: "evidence-reused",
        relevanceScore: null,
      }],
      skipDuplicates: true,
    });
  });
});
