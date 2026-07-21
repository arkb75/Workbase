import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCandidate: vi.fn(),
  updateCandidates: vi.fn(),
  updateCandidate: vi.fn(),
  countCandidates: vi.fn(),
  findRun: vi.fn(),
  findEvidence: vi.fn(),
  updateEvidence: vi.fn(),
  updateFacts: vi.fn(),
  transaction: vi.fn(),
  upsertFactEmbedding: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("workflow/api", () => ({ resumeHook: mocks.resumeHook }));
vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    agentRunCandidate: {
      findFirstOrThrow: mocks.findCandidate,
      updateMany: mocks.updateCandidates,
      update: mocks.updateCandidate,
      count: mocks.countCandidates,
    },
    agentRun: { findUnique: mocks.findRun },
    evidenceItem: {
      findMany: mocks.findEvidence,
      updateMany: mocks.updateEvidence,
    },
    projectFact: { updateMany: mocks.updateFacts },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/src/services/knowledge-embedding-service", () => ({
  buildProjectFactEmbeddingText: vi.fn((fact) => `${fact.category} ${fact.statement}`),
  upsertProjectFactEmbedding: mocks.upsertFactEmbedding,
}));
vi.mock("@/src/services/highlight-suggestion-service", () => ({
  coerceStoredHighlightDraft: vi.fn(() => null),
  refreshHighlightEmbeddingFromDraft: vi.fn(),
}));
vi.mock("@/src/lib/evidence-persistence", () => ({
  createHighlightWithRelations: vi.fn(),
}));

import { resolveAgentCandidate } from "@/src/services/candidate-review-service";

function projectFactCandidate() {
  return {
    id: "candidate-1",
    agentRunId: "run-1",
    batchNumber: 1,
    ordinal: 1,
    status: "pending",
    kind: "new_project_fact",
    snapshot: { statement: "The runtime uses durable workflows." },
    editedText: null,
    feedback: null,
    reviewedAt: null,
    highlightId: null,
    projectFactId: "fact-1",
    highlightSuggestionId: null,
    agentRun: { id: "run-1", userId: "user-1", workItemId: "work-1" },
    highlight: null,
    highlightSuggestion: null,
    projectFact: {
      id: "fact-1",
      workItemId: "work-1",
      statement: "The runtime uses durable workflows.",
      category: "architecture",
      confidence: "high",
      status: "draft",
      sensitivityFlag: false,
      reviewNotes: null,
      searchText: "durable workflows",
      supersedesProjectFactId: null,
      lifecycleStatus: "quarantined",
      reviewState: "pending_review",
      approvalSource: "automation",
      evidence: [{
        evidenceItemId: "evidence-1",
        relevanceScore: 1,
        evidenceItem: {
          id: "evidence-1",
          workItemId: "work-1",
          included: false,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
        },
      }],
    },
  };
}

function input() {
  return {
    userId: "user-1",
    candidateId: "candidate-1",
    decision: "approve" as const,
    idempotencyKey: "candidate-1:approve",
  };
}

describe("candidate review mutation fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.countCandidates.mockResolvedValue(1);
    mocks.findRun.mockResolvedValue({ status: "awaiting_review" });
    mocks.resumeHook.mockResolvedValue({ runId: "workflow-1" });
    mocks.updateCandidates.mockResolvedValue({ count: 1 });
    mocks.updateEvidence.mockResolvedValue({ count: 1 });
    mocks.updateFacts.mockResolvedValue({ count: 1 });
    mocks.upsertFactEmbedding.mockResolvedValue({});
  });

  it("fails closed when cited Evidence was excluded after candidate creation", async () => {
    const candidate = projectFactCandidate();
    mocks.findCandidate.mockResolvedValue(candidate);
    mocks.findEvidence.mockResolvedValue([{
      id: "evidence-1",
      included: false,
      lifecycleStatus: "active",
      reviewState: "reviewed",
      approvalSource: "user",
    }]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      agentRunCandidate: {
        findFirstOrThrow: mocks.findCandidate,
        updateMany: mocks.updateCandidates,
        update: mocks.updateCandidate,
      },
      evidenceItem: { findMany: mocks.findEvidence, updateMany: mocks.updateEvidence },
      projectFact: { updateMany: mocks.updateFacts },
    };
    mocks.transaction.mockImplementation(async (operation) => operation(tx));

    await expect(resolveAgentCandidate(input())).rejects.toThrow(
      "Supporting evidence changed or was excluded",
    );
    expect(mocks.updateCandidates).not.toHaveBeenCalled();
    expect(mocks.updateFacts).not.toHaveBeenCalled();
    expect(mocks.updateEvidence).not.toHaveBeenCalled();
  });

  it("serializes concurrent approvals and activates the candidate exactly once", async () => {
    let candidate = projectFactCandidate();
    let evidence = [{
      id: "evidence-1",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
    }];
    let preflightReads = 0;
    let releasePreflights!: () => void;
    const bothPreflights = new Promise<void>((resolve) => { releasePreflights = resolve; });
    mocks.findCandidate.mockImplementation(async () => {
      if (preflightReads < 2) {
        preflightReads += 1;
        if (preflightReads === 2) releasePreflights();
        else await bothPreflights;
      }
      return candidate;
    });
    mocks.findEvidence.mockImplementation(async () => evidence);
    mocks.updateCandidates.mockImplementation(async ({ where, data }) => {
      if (where.status !== "pending" || candidate.status !== "pending") return { count: 0 };
      candidate = { ...candidate, ...data };
      return { count: 1 };
    });
    mocks.updateEvidence.mockImplementation(async () => {
      evidence = evidence.map((entry) => ({
        ...entry,
        included: true,
        reviewState: "reviewed",
        approvalSource: "user",
      }));
      return { count: 1 };
    });
    mocks.updateFacts.mockImplementation(async ({ where, data }) => {
      if (where.status !== "draft" || candidate.projectFact!.status !== "draft") return { count: 0 };
      candidate = {
        ...candidate,
        projectFact: { ...candidate.projectFact!, ...data },
      };
      return { count: 1 };
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      agentRunCandidate: {
        findFirstOrThrow: mocks.findCandidate,
        updateMany: mocks.updateCandidates,
        update: mocks.updateCandidate,
      },
      evidenceItem: { findMany: mocks.findEvidence, updateMany: mocks.updateEvidence },
      projectFact: { updateMany: mocks.updateFacts },
    };
    let tail = Promise.resolve();
    mocks.transaction.mockImplementation(async (operation) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation(tx);
      } finally {
        release();
      }
    });

    const results = await Promise.all([
      resolveAgentCandidate(input()),
      resolveAgentCandidate(input()),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "approved" }),
      expect.objectContaining({ status: "approved" }),
    ]);
    expect(mocks.updateFacts).toHaveBeenCalledTimes(1);
    expect(mocks.updateEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.updateCandidates).toHaveBeenCalledTimes(1);
  });

  it("replays a failed post-commit embedding on an idempotent review retry", async () => {
    const candidate = projectFactCandidate();
    candidate.status = "approved";
    candidate.projectFact!.status = "approved";
    candidate.projectFact!.lifecycleStatus = "active";
    candidate.projectFact!.reviewState = "reviewed";
    mocks.findCandidate.mockResolvedValue(candidate);
    mocks.upsertFactEmbedding
      .mockRejectedValueOnce(new Error("embedding provider unavailable"))
      .mockResolvedValueOnce({});

    await expect(resolveAgentCandidate(input())).resolves.toMatchObject({ status: "approved" });
    await expect(resolveAgentCandidate(input())).resolves.toMatchObject({ status: "approved" });

    expect(mocks.upsertFactEmbedding).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
