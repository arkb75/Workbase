import { beforeEach, describe, expect, it, vi } from "vitest";

type Candidate = {
  id: string;
  agentRunId: string;
  highlightId: string | null;
  projectFactId: null;
  highlightSuggestionId: null;
  kind: "new_highlight";
  status: "approved";
  batchNumber: number;
  ordinal: number;
  snapshot: unknown;
  editedText: null;
  feedback: null;
  reviewedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type RevisionTarget = {
  id: string;
  workItemId: string;
  text: string;
  summary: string;
  confidence: "high";
  ownershipClarity: "clear";
  sensitivityFlag: false;
  verificationStatus: "approved";
  visibility: "private";
  risksSummary: null;
  missingInfo: null;
  rejectionReason: null;
  verificationNotes: string;
  metadata: null;
  lifecycleStatus: "active" | "superseded" | "stale";
  evidence: [];
  tags: [];
  createdAt: Date;
  updatedAt: Date;
};

const state = vi.hoisted(() => ({
  runStatus: "running",
  candidates: [] as Candidate[],
  nextHighlight: 1,
  nextCandidate: 1,
  transactionTail: Promise.resolve() as Promise<void>,
  revisionTarget: null as RevisionTarget | null,
}));

const mocks = vi.hoisted(() => ({
  agentRunCandidateFindFirst: vi.fn(),
  agentRunFindFirst: vi.fn(),
  workItemFindFirstOrThrow: vi.fn(),
  transaction: vi.fn(),
  sourceUpsert: vi.fn(),
  evidenceUpsert: vi.fn(),
  evidenceTagCreateMany: vi.fn(),
  evidenceUpdate: vi.fn(),
  highlightCreate: vi.fn(),
  highlightUpdate: vi.fn(),
  highlightUpdateMany: vi.fn(),
  candidateCreate: vi.fn(),
  candidateCount: vi.fn(),
  reviewChange: vi.fn(),
  claimResearch: vi.fn(),
  claimVerification: vi.fn(),
  publicVerification: vi.fn(),
  embedding: vi.fn(),
  knowledgeLockObserved: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    agentRunCandidate: { findFirst: mocks.agentRunCandidateFindFirst },
    agentRun: { findFirst: mocks.agentRunFindFirst },
    workItem: { findFirstOrThrow: mocks.workItemFindFirstOrThrow },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/src/lib/llm-config", () => ({
  resolveBedrockConfig: () => ({ modelId: "test-model" }),
  resolveActiveTextModelIdentity: () => ({
    provider: "bedrock",
    modelId: "test-model",
  }),
}));

vi.mock("@/src/lib/evidence-persistence", () => ({
  createHighlightWithRelations: vi.fn(async ({ tx, draft }: {
    tx: { highlight: { create: (input: unknown) => Promise<{ id: string }> } };
    draft: unknown;
  }) => tx.highlight.create({ data: { draft } })),
}));

vi.mock("@/src/lib/generation-run-metadata", () => ({
  readGenerationRunMetadata: () => null,
}));

vi.mock("@/src/services/claim-research-service", () => ({
  claimResearchService: { generate: mocks.claimResearch },
}));

vi.mock("@/src/services/claim-verification-service", () => ({
  claimVerificationService: { verify: mocks.claimVerification },
}));

vi.mock("@/src/services/public-knowledge-verification-service", () => ({
  publicKnowledgeVerificationService: { verify: mocks.publicVerification },
}));

vi.mock("@/src/services/highlight-embedding-service", () => ({
  buildHighlightEmbeddingText: ({ text }: { text: string }) => text,
  findNearestHighlightEmbedding: vi.fn().mockResolvedValue([]),
  upsertHighlightEmbedding: mocks.embedding,
}));

vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChangeInTransaction: mocks.reviewChange,
}));

vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  KNOWLEDGE_LIFECYCLE_POLICY_VERSION: "test-policy",
}));

import { proposeHighlightFromChatContext } from "@/src/services/chat-highlight-candidate-service";

function workItem(highlights: RevisionTarget[] = []) {
  return {
    id: "work-1",
    userId: "user-1",
    title: "Workbase",
    type: "project",
    description: "Project",
    startDate: null,
    endDate: null,
    highlights,
  };
}

function activeRevisionTarget(): RevisionTarget {
  const now = new Date("2026-07-20T12:00:00.000Z");
  return {
    id: "highlight-target",
    workItemId: "work-1",
    text: "I designed and shipped repository batching, reducing import latency by 37%.",
    summary: "Designed repository batching and measured a 37% latency reduction.",
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    visibility: "private",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: "Previously approved.",
    metadata: null,
    lifecycleStatus: "active",
    evidence: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

function verifiedDraft() {
  return {
    text: "I designed and shipped repository batching, reducing import latency by 37%.",
    summary: "Designed repository batching and measured a 37% latency reduction.",
    confidence: "high" as const,
    ownershipClarity: "clear" as const,
    sensitivityFlag: false,
    verificationStatus: "approved" as const,
    visibility: "private" as const,
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: "Supported by the user's statement.",
    metadata: null,
    evidence: {
      summary: "Self-reported context.",
      verificationNotes: "Self-reported.",
      sourceRefs: [{
        evidenceItemId: "transient-chat-evidence:message-1",
        sourceId: "transient-chat-source:thread-1",
        sourceLabel: "Self-reported chat context",
        sourceType: "chat_context" as const,
        title: "Self-reported project context",
        excerpt: "I designed and shipped repository batching, reducing import latency by 37%.",
      }],
    },
    tags: [],
  };
}

type CandidateInput = {
  userId: string;
  workItemId: string;
  threadId: string;
  messageId: string;
  agentRunId: string;
  text: string;
};

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    userId: "user-1",
    workItemId: "work-1",
    threadId: "thread-1",
    messageId: "message-1",
    agentRunId: "run-1",
    text: "I designed and shipped repository batching, reducing import latency by 37%.",
    ...overrides,
  };
}

function storedCandidate(): Candidate {
  const now = new Date();
  return {
    id: "candidate-existing",
    agentRunId: "run-1",
    highlightId: "highlight-existing",
    projectFactId: null,
    highlightSuggestionId: null,
    kind: "new_highlight",
    status: "approved",
    batchNumber: 1,
    ordinal: 1,
    snapshot: {},
    editedText: null,
    feedback: null,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function installTransactionStore() {
  mocks.transaction.mockImplementation(async (
    task: (tx: Record<string, unknown>) => Promise<unknown>,
  ) => {
    const previous = state.transactionTail;
    let releaseTransaction!: () => void;
    state.transactionTail = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previous;

    const tx = {
      $queryRaw: vi.fn(async (
        strings: TemplateStringsArray,
      ) => {
        const query = Array.from(strings).join("?");
        if (query.includes('FROM "AgentRun"')) return [{ status: state.runStatus }];
        mocks.knowledgeLockObserved();
        return [{ locked: 1 }];
      }),
      source: { upsert: mocks.sourceUpsert },
      evidenceItem: {
        upsert: mocks.evidenceUpsert,
        update: mocks.evidenceUpdate,
      },
      evidenceTag: { createMany: mocks.evidenceTagCreateMany },
      highlight: {
        create: mocks.highlightCreate,
        findFirst: vi.fn(async (args: {
          where: { id: string; lifecycleStatus: string; updatedAt: Date };
        }) => {
          const target = state.revisionTarget;
          return target &&
              target.id === args.where.id &&
              target.lifecycleStatus === args.where.lifecycleStatus &&
              target.updatedAt.getTime() === args.where.updatedAt.getTime()
            ? { id: target.id, text: target.text, updatedAt: target.updatedAt }
            : null;
        }),
        update: mocks.highlightUpdate,
        updateMany: mocks.highlightUpdateMany,
      },
      highlightSuggestion: { create: vi.fn() },
      agentRunCandidate: {
        findFirst: vi.fn(async (args: { where: { agentRunId: string } }) =>
          state.candidates.find((candidate) => candidate.agentRunId === args.where.agentRunId) ?? null
        ),
        count: mocks.candidateCount,
        create: mocks.candidateCreate,
      },
    };
    try {
      return await task(tx);
    } finally {
      releaseTransaction();
    }
  });
}

describe("chat Highlight candidate cancellation fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WORKBASE_CHAT_CONTEXT_GENERATION_MODE = "model";
    state.runStatus = "running";
    state.candidates = [];
    state.nextHighlight = 1;
    state.nextCandidate = 1;
    state.transactionTail = Promise.resolve();
    state.revisionTarget = null;

    mocks.agentRunCandidateFindFirst.mockImplementation(async (args: {
      where: { agentRunId: string };
    }) => state.candidates.find((candidate) => candidate.agentRunId === args.where.agentRunId) ?? null);
    mocks.agentRunFindFirst.mockResolvedValue({ id: "run-1" });
    mocks.workItemFindFirstOrThrow.mockResolvedValue(workItem());
    mocks.sourceUpsert.mockResolvedValue({ id: "source-1", label: "Self-reported chat context" });
    mocks.evidenceUpsert.mockResolvedValue({
      id: "evidence-1",
      title: "Self-reported project context",
      content: candidateInput().text,
    });
    mocks.evidenceTagCreateMany.mockResolvedValue({ count: 0 });
    mocks.evidenceUpdate.mockResolvedValue({ id: "evidence-1" });
    mocks.highlightCreate.mockImplementation(async () => ({ id: `highlight-${state.nextHighlight++}` }));
    mocks.highlightUpdate.mockResolvedValue({ id: "highlight-1" });
    mocks.highlightUpdateMany.mockImplementation(async (args: {
      where: { id: string; lifecycleStatus: string; updatedAt?: Date };
      data: { lifecycleStatus: RevisionTarget["lifecycleStatus"] };
    }) => {
      const target = state.revisionTarget;
      if (!target || target.id !== args.where.id || target.lifecycleStatus !== args.where.lifecycleStatus) {
        return { count: 0 };
      }
      if (args.where.updatedAt && target.updatedAt.getTime() !== args.where.updatedAt.getTime()) {
        return { count: 0 };
      }
      target.lifecycleStatus = args.data.lifecycleStatus;
      target.updatedAt = new Date(target.updatedAt.getTime() + 1);
      return { count: 1 };
    });
    mocks.candidateCount.mockImplementation(async (args: {
      where: { agentRunId: string };
    }) => state.candidates.filter((candidate) => candidate.agentRunId === args.where.agentRunId).length);
    mocks.candidateCreate.mockImplementation(async (args: {
      data: Omit<Candidate, "id" | "projectFactId" | "highlightSuggestionId" | "editedText" | "feedback" | "createdAt" | "updatedAt">;
    }) => {
      const now = new Date();
      const candidate: Candidate = {
        id: `candidate-${state.nextCandidate++}`,
        ...args.data,
        projectFactId: null,
        highlightSuggestionId: null,
        editedText: null,
        feedback: null,
        createdAt: now,
        updatedAt: now,
      };
      state.candidates.push(candidate);
      return candidate;
    });
    mocks.publicVerification.mockResolvedValue({
      eligible: true,
      correctedText: null,
      reasons: [],
      claimChecks: [],
      tokenUsage: null,
    });
    mocks.embedding.mockResolvedValue(undefined);
    mocks.reviewChange.mockResolvedValue({ id: "change-1" });
    installTransactionStore();
  });

  it("leaves no project-knowledge or review mutations when cancellation wins during extraction", async () => {
    let releaseResearch!: (value: ReturnType<typeof verifiedDraft>) => void;
    mocks.claimResearch.mockImplementation(() => new Promise((resolve) => {
      releaseResearch = () => resolve({
        highlights: [verifiedDraft()],
        generationRunIds: { generation: ["generation-1"], verification: null },
      });
    }));
    mocks.claimVerification.mockImplementation(async ({ highlights }) => highlights);

    const proposed = proposeHighlightFromChatContext(candidateInput());
    await vi.waitFor(() => expect(mocks.claimResearch).toHaveBeenCalledOnce());
    state.runStatus = "cancelled";
    releaseResearch(verifiedDraft());

    await expect(proposed).resolves.toBeNull();
    expect(mocks.sourceUpsert).not.toHaveBeenCalled();
    expect(mocks.evidenceUpsert).not.toHaveBeenCalled();
    expect(mocks.evidenceTagCreateMany).not.toHaveBeenCalled();
    expect(mocks.highlightCreate).not.toHaveBeenCalled();
    expect(mocks.highlightUpdate).not.toHaveBeenCalled();
    expect(mocks.evidenceUpdate).not.toHaveBeenCalled();
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
    expect(mocks.reviewChange).not.toHaveBeenCalled();
    expect(mocks.embedding).not.toHaveBeenCalled();
    expect(state.candidates).toEqual([]);
  });

  it("leaves no project-knowledge or review mutations when cancellation wins during verification", async () => {
    mocks.claimResearch.mockResolvedValue({
      highlights: [verifiedDraft()],
      generationRunIds: { generation: ["generation-1"], verification: null },
    });
    let releaseVerification!: () => void;
    mocks.claimVerification.mockImplementation(() => new Promise((resolve) => {
      releaseVerification = () => resolve([verifiedDraft()]);
    }));

    const proposed = proposeHighlightFromChatContext(candidateInput());
    await vi.waitFor(() => expect(mocks.claimVerification).toHaveBeenCalledOnce());
    state.runStatus = "cancelled";
    releaseVerification();

    await expect(proposed).resolves.toBeNull();
    expect(mocks.sourceUpsert).not.toHaveBeenCalled();
    expect(mocks.evidenceUpsert).not.toHaveBeenCalled();
    expect(mocks.evidenceTagCreateMany).not.toHaveBeenCalled();
    expect(mocks.highlightCreate).not.toHaveBeenCalled();
    expect(mocks.highlightUpdate).not.toHaveBeenCalled();
    expect(mocks.evidenceUpdate).not.toHaveBeenCalled();
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
    expect(mocks.reviewChange).not.toHaveBeenCalled();
    expect(mocks.embedding).not.toHaveBeenCalled();
    expect(state.candidates).toEqual([]);
  });

  it("materializes one atomic winner when the same active run is replayed concurrently", async () => {
    mocks.claimResearch.mockResolvedValue({
      highlights: [verifiedDraft()],
      generationRunIds: { generation: ["generation-1"], verification: null },
    });
    mocks.claimVerification.mockImplementation(async ({ highlights }) => highlights);

    const [first, second] = await Promise.all([
      proposeHighlightFromChatContext(candidateInput()),
      proposeHighlightFromChatContext(candidateInput()),
    ]);

    expect(first?.id).toBe("candidate-1");
    expect(second?.id).toBe("candidate-1");
    expect(state.candidates).toHaveLength(1);
    expect(mocks.sourceUpsert).toHaveBeenCalledOnce();
    expect(mocks.evidenceUpsert).toHaveBeenCalledOnce();
    expect(mocks.highlightCreate).toHaveBeenCalledOnce();
    expect(mocks.evidenceUpdate).toHaveBeenCalledWith({
      where: { id: "evidence-1" },
      data: expect.objectContaining({ included: true, lifecycleStatus: "active" }),
    });
    expect(mocks.candidateCreate).toHaveBeenCalledOnce();
    expect(mocks.reviewChange).toHaveBeenCalledOnce();
    expect(mocks.embedding).toHaveBeenCalledOnce();
  });

  it("does not create parallel successors when concurrent chat runs matched the same active revision", async () => {
    process.env.WORKBASE_CHAT_CONTEXT_GENERATION_MODE = "deterministic";
    const target = activeRevisionTarget();
    state.revisionTarget = target;
    mocks.workItemFindFirstOrThrow.mockResolvedValue(workItem([target]));

    const [winner, staleFollower] = await Promise.all([
      proposeHighlightFromChatContext(candidateInput()),
      proposeHighlightFromChatContext(candidateInput({
        agentRunId: "run-2",
        threadId: "thread-2",
        messageId: "message-2",
      })),
    ]);

    expect(winner?.id).toBe("candidate-1");
    expect(staleFollower).toBeNull();
    expect(state.candidates).toHaveLength(1);
    expect(state.revisionTarget?.lifecycleStatus).toBe("superseded");
    expect(mocks.knowledgeLockObserved).toHaveBeenCalledTimes(2);
    expect(mocks.sourceUpsert).toHaveBeenCalledOnce();
    expect(mocks.evidenceUpsert).toHaveBeenCalledOnce();
    expect(mocks.highlightCreate).toHaveBeenCalledOnce();
    expect(mocks.highlightUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.candidateCreate).toHaveBeenCalledOnce();
    expect(mocks.reviewChange).toHaveBeenCalledOnce();
    expect(mocks.embedding).toHaveBeenCalledOnce();
  });

  it("drops a revision without side effects when review or reconciliation changed its selected snapshot first", async () => {
    process.env.WORKBASE_CHAT_CONTEXT_GENERATION_MODE = "deterministic";
    const target = activeRevisionTarget();
    state.revisionTarget = target;
    mocks.workItemFindFirstOrThrow.mockResolvedValue(workItem([target]));
    mocks.knowledgeLockObserved.mockImplementationOnce(() => {
      target.lifecycleStatus = "stale";
      target.updatedAt = new Date(target.updatedAt.getTime() + 1);
    });

    await expect(proposeHighlightFromChatContext(candidateInput())).resolves.toBeNull();

    expect(mocks.knowledgeLockObserved).toHaveBeenCalledOnce();
    expect(mocks.sourceUpsert).not.toHaveBeenCalled();
    expect(mocks.evidenceUpsert).not.toHaveBeenCalled();
    expect(mocks.highlightCreate).not.toHaveBeenCalled();
    expect(mocks.highlightUpdateMany).not.toHaveBeenCalled();
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
    expect(mocks.reviewChange).not.toHaveBeenCalled();
    expect(mocks.embedding).not.toHaveBeenCalled();
  });

  it("returns the committed winner on terminal replay without reopening side effects", async () => {
    const existing = storedCandidate();
    state.candidates = [existing];
    state.runStatus = "cancelled";

    await expect(proposeHighlightFromChatContext(candidateInput())).resolves.toEqual(existing);
    expect(mocks.agentRunFindFirst).not.toHaveBeenCalled();
    expect(mocks.claimResearch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.embedding).not.toHaveBeenCalled();
    expect(mocks.reviewChange).not.toHaveBeenCalled();
  });
});
