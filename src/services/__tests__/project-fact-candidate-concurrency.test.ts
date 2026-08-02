import { beforeEach, describe, expect, it, vi } from "vitest";

const COMMIT_SHA = "a".repeat(40);
const NEXT_COMMIT_SHA = "b".repeat(40);

type FactRow = {
  id: string;
  workItemId: string;
  statement: string;
  category: "architecture" | "behavior" | "data_flow" | "code_location" | "dependency" | "configuration";
  confidence: "low" | "medium" | "high";
  status: "draft" | "approved" | "rejected" | "superseded";
  lifecycleStatus: "active" | "needs_validation" | "stale" | "superseded" | "retired" | "quarantined";
  reviewNotes: string | null;
  updatedAt: Date;
  evidence: Array<{
    evidenceItemId: string;
    evidenceItem: { metadata: { commitSha: string } };
  }>;
};

type EvidenceRow = {
  id: string;
  included: boolean;
  lifecycleStatus: "active" | "needs_validation" | "stale";
  reviewState: "pending_review" | "reviewed" | "reverted";
  approvalSource: "automation" | "user" | "legacy";
};

type CandidateRow = {
  id: string;
  agentRunId: string;
  projectFactId: string;
  kind: "new_project_fact" | "project_fact_revision";
  status: "pending" | "approved" | "edited_and_approved" | "denied";
  batchNumber: number;
  ordinal: number;
  projectFact: FactRow | null;
};

const prismaMock = vi.hoisted(() => ({
  agentRunCandidate: { findMany: vi.fn() },
  agentRun: { findFirstOrThrow: vi.fn() },
  workItem: { findFirstOrThrow: vi.fn() },
  evidenceItem: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
const promoteRepositoryCitationsMock = vi.hoisted(() => vi.fn());
const upsertProjectFactEmbeddingMock = vi.hoisted(() => vi.fn());
const recordChangeMock = vi.hoisted(() => vi.fn());
const generateStructuredMock = vi.hoisted(() => vi.fn());
const providerState = vi.hoisted(() => ({ value: "bedrock" as "bedrock" | "mock" }));
const advisoryLockObservedMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => providerState.value,
}));
vi.mock("@/src/services/bedrock-runtime", () => ({
  getBedrockStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
  getStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));
vi.mock("@/src/services/repository-evidence-promotion-service", () => ({
  promoteRepositoryCitations: promoteRepositoryCitationsMock,
}));
vi.mock("@/src/services/knowledge-embedding-service", () => ({
  buildProjectFactEmbeddingText: ({ statement }: { statement: string }) => statement,
  upsertProjectFactEmbedding: upsertProjectFactEmbeddingMock,
}));
vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  recordChange: recordChangeMock,
}));

import { createProjectFactCandidates } from "@/src/services/project-fact-service";

let factRows: FactRow[];
let candidateRows: CandidateRow[];
let evidenceRows: EvidenceRow[];
let transactionFailures: Array<() => Error>;
let nextFactId: number;
let nextCandidateId: number;
let lockTail: Promise<void>;
let agentRunStatuses: Map<string, string>;

function candidateStateForRun(runId: string) {
  return candidateRows
    .filter((candidate) => candidate.agentRunId === runId)
    .sort((left, right) =>
      left.batchNumber - right.batchNumber || left.ordinal - right.ordinal
    );
}

function makeFact(input: Partial<FactRow> & Pick<FactRow, "id" | "statement">): FactRow {
  return {
    id: input.id,
    workItemId: input.workItemId ?? "work-1",
    statement: input.statement,
    category: input.category ?? "architecture",
    confidence: input.confidence ?? "high",
    status: input.status ?? "approved",
    lifecycleStatus: input.lifecycleStatus ?? "active",
    reviewNotes: input.reviewNotes ?? null,
    updatedAt: input.updatedAt ?? new Date(),
    evidence: input.evidence ?? [{
      evidenceItemId: "evidence-1",
      evidenceItem: { metadata: { commitSha: COMMIT_SHA } },
    }],
  };
}

function makeCandidate(input: {
  id: string;
  runId: string;
  fact: FactRow;
  status?: CandidateRow["status"];
  ordinal?: number;
}): CandidateRow {
  return {
    id: input.id,
    agentRunId: input.runId,
    projectFactId: input.fact.id,
    kind: "new_project_fact",
    status: input.status ?? "approved",
    batchNumber: 1,
    ordinal: input.ordinal ?? 1,
    projectFact: input.fact,
  };
}

function installTransactionalStore() {
  prismaMock.agentRunCandidate.findMany.mockImplementation(async (args: {
    where: { agentRunId: string };
  }) => candidateStateForRun(args.where.agentRunId));

  prismaMock.$transaction.mockImplementation(async (
    task: (tx: Record<string, unknown>) => Promise<unknown>,
  ) => {
    const failure = transactionFailures.shift();
    if (failure) throw failure();

    const lockLease: { release?: () => void } = {};
    const tx = {
      $queryRaw: vi.fn(async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const query = Array.from(strings).join("?");
        if (query.includes('FROM "AgentRun"')) {
          const runId = String(values[0]);
          return [{ status: agentRunStatuses.get(runId) ?? "running" }];
        }
        advisoryLockObservedMock();
        const previous = lockTail;
        lockTail = new Promise<void>((resolve) => {
          lockLease.release = resolve;
        });
        await previous;
        return [{ pg_advisory_xact_lock: null }];
      }),
      agentRunCandidate: {
        findMany: vi.fn(async (args: { where: { agentRunId: string } }) =>
          candidateStateForRun(args.where.agentRunId).map(({ id }) => ({ id }))
        ),
        create: vi.fn(async (args: {
          data: {
            agentRunId: string;
            projectFactId: string;
            kind: CandidateRow["kind"];
            status: CandidateRow["status"];
            batchNumber: number;
            ordinal: number;
          };
        }) => {
          if (candidateRows.some((candidate) =>
            candidate.agentRunId === args.data.agentRunId &&
            candidate.batchNumber === args.data.batchNumber &&
            candidate.ordinal === args.data.ordinal
          )) {
            throw Object.assign(new Error("Unique constraint failed."), { code: "P2002" });
          }
          const fact = factRows.find((entry) => entry.id === args.data.projectFactId) ?? null;
          const candidate = {
            id: `candidate-${nextCandidateId++}`,
            ...args.data,
            projectFact: fact,
          };
          candidateRows.push(candidate);
          return candidate;
        }),
      },
      projectFact: {
        findMany: vi.fn(async () => factRows.filter((fact) =>
          fact.workItemId === "work-1" &&
          fact.status === "approved" &&
          fact.lifecycleStatus === "active"
        )),
        create: vi.fn(async (args: {
          data: {
            workItemId: string;
            statement: string;
            category: FactRow["category"];
            confidence: FactRow["confidence"];
            status: FactRow["status"];
            lifecycleStatus: FactRow["lifecycleStatus"];
            reviewNotes: string | null;
          };
        }) => {
          const fact = makeFact({
            id: `fact-${nextFactId++}`,
            workItemId: args.data.workItemId,
            statement: args.data.statement,
            category: args.data.category,
            confidence: args.data.confidence,
            status: args.data.status,
            lifecycleStatus: args.data.lifecycleStatus,
            reviewNotes: args.data.reviewNotes,
          });
          factRows.push(fact);
          return fact;
        }),
        updateMany: vi.fn(async (args: {
          where: { id: string; status: FactRow["status"]; lifecycleStatus: FactRow["lifecycleStatus"] };
          data: { status: FactRow["status"]; lifecycleStatus: FactRow["lifecycleStatus"] };
        }) => {
          const fact = factRows.find((entry) =>
            entry.id === args.where.id &&
            entry.status === args.where.status &&
            entry.lifecycleStatus === args.where.lifecycleStatus
          );
          if (!fact) return { count: 0 };
          fact.status = args.data.status;
          fact.lifecycleStatus = args.data.lifecycleStatus;
          return { count: 1 };
        }),
      },
      evidenceItem: {
        updateMany: vi.fn(async (args: {
          where: {
            id: { in: string[] };
            approvalSource?: { not: EvidenceRow["approvalSource"] };
            reviewState?: EvidenceRow["reviewState"];
          };
          data: Partial<EvidenceRow>;
        }) => {
          let count = 0;
          for (const evidence of evidenceRows) {
            if (!args.where.id.in.includes(evidence.id)) continue;
            if (
              args.where.approvalSource &&
              evidence.approvalSource === args.where.approvalSource.not
            ) continue;
            if (args.where.reviewState && evidence.reviewState !== args.where.reviewState) continue;
            Object.assign(evidence, args.data);
            count += 1;
          }
          return { count };
        }),
      },
    };

    try {
      return await task(tx);
    } finally {
      lockLease.release?.();
    }
  });
}

function researchInput(runId: string, input?: {
  question?: string;
  excerpt?: string;
  maxFacts?: number;
  commitSha?: string;
}) {
  return {
    runId,
    userId: "user-1",
    workItemId: "work-1",
    question: input?.question ?? "Summarize the current repository architecture.",
    citations: [{
      kind: "github_file" as const,
      label: "src/agent.ts",
      excerpt: input?.excerpt ?? "export const architecture = 'durable';",
      sourceId: "source-1",
      repository: "workbase/demo",
      commitSha: input?.commitSha ?? COMMIT_SHA,
      blobSha: "blob-1",
      path: "src/agent.ts",
      startLine: 1,
      endLine: 3,
    }],
    partial: false,
    maxFacts: input?.maxFacts ?? 1,
  };
}

describe("Project Fact candidate concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerState.value = "bedrock";
    factRows = [];
    candidateRows = [];
    evidenceRows = [{
      id: "evidence-1",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
    }];
    transactionFailures = [];
    nextFactId = 1;
    nextCandidateId = 1;
    lockTail = Promise.resolve();
    agentRunStatuses = new Map();
    prismaMock.workItem.findFirstOrThrow.mockResolvedValue({ title: "Workbase" });
    prismaMock.agentRun.findFirstOrThrow.mockImplementation(async (args: {
      where: { id: string };
    }) => ({
      id: args.where.id,
      status: agentRunStatuses.get(args.where.id) ?? "running",
    }));
    prismaMock.evidenceItem.deleteMany.mockResolvedValue({ count: 0 });
    promoteRepositoryCitationsMock.mockImplementation(async (input: {
      citations: unknown[];
      mutationFence?: <T>(operation: (tx: unknown) => Promise<T>) => Promise<T>;
    }) => {
      const result = {
        promotedIds: input.citations.map((_citation, index) => `evidence-${index + 1}`),
        newIds: input.citations.map((_citation, index) => `evidence-${index + 1}`),
        evidenceIdByCitationIndex: new Map(
          input.citations.map((_citation, index) => [index, `evidence-${index + 1}`]),
        ),
      };
      return input.mutationFence
        ? input.mutationFence(async () => result)
        : result;
    });
    generateStructuredMock.mockResolvedValue({
      data: {
        facts: [{
          statement: "The repository uses a durable project architecture.",
          category: "architecture",
          confidence: "high",
          sensitivityFlag: false,
          reviewNotes: null,
          citationIndexes: [1],
        }],
        coverageGaps: [],
      },
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });
    upsertProjectFactEmbeddingMock.mockResolvedValue(undefined);
    recordChangeMock.mockResolvedValue({ id: "change-1" });
    installTransactionalStore();
  });

  it("serializes two invocations for the same run and returns the winning candidate to both", async () => {
    const input = researchInput("run-shared", {
      question: "Where are iteration limits enforced, and what terminates the loop?",
      excerpt: [
        "if (iterations >= limits.maxIterations) {",
        "  throw new Error('stop');",
        "}",
      ].join("\n"),
    });

    const [left, right] = await Promise.all([
      createProjectFactCandidates(input),
      createProjectFactCandidates(input),
    ]);

    expect(factRows).toHaveLength(1);
    expect(candidateRows).toHaveLength(1);
    expect(left.candidateIds).toEqual([candidateRows[0]!.id]);
    expect(right.candidateIds).toEqual([candidateRows[0]!.id]);
    expect(advisoryLockObservedMock).toHaveBeenCalledTimes(2);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("prevents two runs on one work item from creating the same current-revision fact", async () => {
    const inputA = researchInput("run-a", {
      question: "Where are iteration limits enforced, and what terminates the loop?",
      excerpt: [
        "if (iterations >= limits.maxIterations) {",
        "  throw new Error('stop');",
        "}",
      ].join("\n"),
    });
    const inputB = { ...inputA, runId: "run-b" };

    const results = await Promise.all([
      createProjectFactCandidates(inputA),
      createProjectFactCandidates(inputB),
    ]);

    expect(factRows).toHaveLength(1);
    expect(candidateRows).toHaveLength(1);
    expect(results.flatMap((result) => result.candidateIds)).toEqual([candidateRows[0]!.id]);
    expect(results.every((result) =>
      result.activeProjectFactIds.length === 1 &&
      result.activeProjectFactIds[0] === factRows[0]!.id
    )).toBe(true);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateIds: [],
        activeProjectFactIds: [factRows[0]!.id],
      }),
    ]));
    expect(prismaMock.evidenceItem.deleteMany).not.toHaveBeenCalled();
  });

  it("reuses an approved fact when a later commit cites the same immutable evidence", async () => {
    const existing = makeFact({
      id: "fact-existing",
      statement: "The repository uses a durable project architecture.",
      evidence: [{
        evidenceItemId: "evidence-1",
        evidenceItem: { metadata: { commitSha: COMMIT_SHA } },
      }],
    });
    factRows.push(existing);

    const result = await createProjectFactCandidates(researchInput("run-next-head", {
      commitSha: NEXT_COMMIT_SHA,
    }));

    expect(factRows).toEqual([existing]);
    expect(candidateRows).toHaveLength(0);
    expect(result).toMatchObject({
      candidateIds: [],
      activeProjectFactIds: ["fact-existing"],
    });
    expect(recordChangeMock).not.toHaveBeenCalled();
  });

  it("retries a P2034 persistence failure without repeating model extraction", async () => {
    transactionFailures.push(() =>
      Object.assign(new Error("TransactionWriteConflict"), { code: "P2034" })
    );

    const result = await createProjectFactCandidates(researchInput("run-retry"));

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(promoteRepositoryCitationsMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(result.candidateIds).toHaveLength(1);
    expect(result).toMatchObject({
      modelInvoked: true,
      fallbackUsed: false,
    });
    expect(factRows).toHaveLength(1);
  });

  it("treats a P2002 winner as an idempotent success without repeating extraction", async () => {
    transactionFailures.push(() => {
      const fact = makeFact({
        id: "fact-winner",
        statement: "The repository uses a durable project architecture.",
      });
      factRows.push(fact);
      candidateRows.push(makeCandidate({
        id: "candidate-winner",
        runId: "run-unique-race",
        fact,
      }));
      return Object.assign(new Error("Unique constraint failed."), { code: "P2002" });
    });

    const result = await createProjectFactCandidates(researchInput("run-unique-race"));

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(result.candidateIds).toEqual(["candidate-winner"]);
    expect(recordChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      entityId: "fact-winner",
      action: "created",
    }));
  });

  it("replays edited active facts, excludes superseded facts, and repairs side effects", async () => {
    const edited = makeFact({
      id: "fact-edited",
      statement: "The reviewed fact uses the user's edited statement.",
    });
    const superseded = makeFact({
      id: "fact-old",
      statement: "This fact is stale.",
      status: "superseded",
      lifecycleStatus: "superseded",
    });
    candidateRows.push(
      makeCandidate({
        id: "candidate-edited",
        runId: "run-replay",
        fact: edited,
        status: "edited_and_approved",
      }),
      makeCandidate({
        id: "candidate-old",
        runId: "run-replay",
        fact: superseded,
        status: "approved",
        ordinal: 2,
      }),
    );

    const result = await createProjectFactCandidates(researchInput("run-replay"));

    expect(result).toMatchObject({
      candidateIds: ["candidate-edited"],
      activeProjectFactIds: ["fact-edited"],
      modelInvoked: false,
      fallbackUsed: false,
    });
    expect(prismaMock.workItem.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "work-1", userId: "user-1" },
      select: { title: true },
    });
    expect(prismaMock.agentRun.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "run-replay", userId: "user-1", workItemId: "work-1" },
      select: { id: true, status: true },
    });
    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(promoteRepositoryCitationsMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(upsertProjectFactEmbeddingMock).toHaveBeenCalledWith(expect.objectContaining({
      projectFactId: "fact-edited",
    }));
    expect(recordChangeMock).toHaveBeenCalledTimes(1);
    expect(recordChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      entityId: "fact-edited",
    }));
  });

  it("reports an explicit deterministic no-model result without repository citations", async () => {
    const input = researchInput("run-no-repository-citations");
    input.citations = [];

    const result = await createProjectFactCandidates(input);

    expect(result).toEqual({
      candidateIds: [],
      activeProjectFactIds: [],
      coverageGaps: [],
      tokenUsage: null,
      modelInvoked: false,
      fallbackUsed: false,
    });
    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(promoteRepositoryCitationsMock).not.toHaveBeenCalled();
  });

  it("authorizes the run and work item before disclosing replayed candidates", async () => {
    const fact = makeFact({
      id: "fact-private",
      statement: "A fact from another project must not be disclosed.",
    });
    candidateRows.push(makeCandidate({
      id: "candidate-private",
      runId: "run-foreign",
      fact,
    }));
    prismaMock.agentRun.findFirstOrThrow.mockRejectedValueOnce(new Error("Run not found."));

    await expect(createProjectFactCandidates(
      researchInput("run-foreign"),
    )).rejects.toThrow("Run not found.");

    expect(prismaMock.agentRunCandidate.findMany).not.toHaveBeenCalled();
    expect(upsertProjectFactEmbeddingMock).not.toHaveBeenCalled();
    expect(recordChangeMock).not.toHaveBeenCalled();
  });

  it("repairs pending review cards without embedding quarantined facts", async () => {
    const fact = makeFact({
      id: "fact-quarantined",
      statement: "This lower-confidence fact still requires review.",
      confidence: "low",
      status: "draft",
      lifecycleStatus: "quarantined",
    });
    candidateRows.push(makeCandidate({
      id: "candidate-quarantined",
      runId: "run-quarantined",
      fact,
      status: "pending",
    }));

    const result = await createProjectFactCandidates(researchInput("run-quarantined"));

    expect(result).toMatchObject({
      candidateIds: ["candidate-quarantined"],
      activeProjectFactIds: [],
    });
    expect(upsertProjectFactEmbeddingMock).not.toHaveBeenCalled();
    expect(recordChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      entityId: "fact-quarantined",
      action: "quarantined",
    }));
  });

  it("returns stored candidates without repair side effects after the run was cancelled", async () => {
    const fact = makeFact({
      id: "fact-cancelled-replay",
      statement: "This fact was materialized before cancellation.",
    });
    candidateRows.push(makeCandidate({
      id: "candidate-cancelled-replay",
      runId: "run-cancelled-replay",
      fact,
    }));
    agentRunStatuses.set("run-cancelled-replay", "cancelled");

    const result = await createProjectFactCandidates(
      researchInput("run-cancelled-replay"),
    );

    expect(result).toMatchObject({
      candidateIds: ["candidate-cancelled-replay"],
      activeProjectFactIds: ["fact-cancelled-replay"],
    });
    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(promoteRepositoryCitationsMock).not.toHaveBeenCalled();
    expect(upsertProjectFactEmbeddingMock).not.toHaveBeenCalled();
    expect(recordChangeMock).not.toHaveBeenCalled();
  });

  it("repairs a review-card write after the fact transaction has committed", async () => {
    recordChangeMock
      .mockRejectedValueOnce(Object.assign(new Error("TransactionWriteConflict"), { code: "P2034" }))
      .mockResolvedValueOnce({ id: "change-repaired" });

    const result = await createProjectFactCandidates(researchInput("run-side-effect-repair"));

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(factRows).toHaveLength(1);
    expect(candidateRows).toHaveLength(1);
    expect(recordChangeMock).toHaveBeenCalledTimes(2);
    expect(result.candidateIds).toEqual([candidateRows[0]!.id]);
  });

  it("serializes review-card side effects for a multi-fact batch", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        facts: [
          "The repository defines a bounded agent loop.",
          "The repository persists durable research state.",
          "The repository promotes immutable evidence excerpts.",
          "The repository records current-head provenance.",
        ].map((statement) => ({
          statement,
          category: "architecture",
          confidence: "high",
          sensitivityFlag: false,
          reviewNotes: null,
          citationIndexes: [1],
        })),
        coverageGaps: [],
      },
      tokenUsage: { inputTokens: 100, outputTokens: 80 },
    });
    let activeWrites = 0;
    let maximumConcurrentWrites = 0;
    recordChangeMock.mockImplementation(async () => {
      activeWrites += 1;
      maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWrites -= 1;
      return { id: `change-${recordChangeMock.mock.calls.length}` };
    });

    const result = await createProjectFactCandidates(researchInput("run-multi-fact", {
      maxFacts: 4,
    }));

    expect(result.candidateIds).toHaveLength(4);
    expect(recordChangeMock).toHaveBeenCalledTimes(4);
    expect(maximumConcurrentWrites).toBe(1);
  });

  it("preserves user-reviewed evidence while creating an auto-safe fact", async () => {
    evidenceRows[0] = {
      id: "evidence-1",
      included: false,
      lifecycleStatus: "active",
      reviewState: "reviewed",
      approvalSource: "user",
    };

    const result = await createProjectFactCandidates(researchInput("run-user-evidence"));

    expect(result.candidateIds).toHaveLength(1);
    expect(evidenceRows[0]).toEqual({
      id: "evidence-1",
      included: false,
      lifecycleStatus: "active",
      reviewState: "reviewed",
      approvalSource: "user",
    });
  });

  it("does not promote evidence or materialize facts after cancellation during extraction", async () => {
    const existing = makeFact({
      id: "fact-existing",
      statement: "The repository uses an earlier project architecture.",
    });
    factRows.push(existing);
    agentRunStatuses.set("run-cancelled-during-extraction", "running");

    let releaseExtraction!: (value: {
      data: {
        facts: Array<{
          statement: string;
          category: "architecture";
          confidence: "high";
          sensitivityFlag: false;
          reviewNotes: null;
          citationIndexes: number[];
        }>;
        coverageGaps: string[];
      };
      tokenUsage: { inputTokens: number; outputTokens: number };
    }) => void;
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    generateStructuredMock.mockImplementationOnce(async () => {
      extractionStarted();
      return new Promise((resolve) => {
        releaseExtraction = resolve;
      });
    });

    const materialization = createProjectFactCandidates(
      researchInput("run-cancelled-during-extraction"),
    );
    await started;
    agentRunStatuses.set("run-cancelled-during-extraction", "cancelled");
    releaseExtraction({
      data: {
        facts: [{
          statement: "The repository now uses a replacement project architecture.",
          category: "architecture",
          confidence: "high",
          sensitivityFlag: false,
          reviewNotes: null,
          citationIndexes: [1],
        }],
        coverageGaps: [],
      },
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });

    await expect(materialization).rejects.toMatchObject({
      name: "InactiveProjectFactRunError",
      message: "Project Fact materialization stopped because the AgentRun is cancelled.",
    });
    expect(promoteRepositoryCitationsMock).not.toHaveBeenCalled();
    expect(candidateRows).toHaveLength(0);
    expect(factRows).toEqual([existing]);
    expect(existing).toMatchObject({
      status: "approved",
      lifecycleStatus: "active",
    });
    expect(evidenceRows).toEqual([{
      id: "evidence-1",
      included: false,
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
    }]);
    expect(upsertProjectFactEmbeddingMock).not.toHaveBeenCalled();
    expect(recordChangeMock).not.toHaveBeenCalled();
  });
});
