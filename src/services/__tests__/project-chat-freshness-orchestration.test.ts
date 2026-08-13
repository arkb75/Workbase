import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const timeline: string[] = [];
  const state = {
    emitAgentEvent: false,
    answerStatus: null as string | null,
    currentQuestion:
      "Summarize my strongest accomplishments and make sure your information is up to date.",
    turnPlanAction: "refresh_then_answer" as "answer" | "refresh_then_answer" | "artifact",
    threadMessages: [] as Array<Record<string, unknown>>,
    workflowRunId: "wrun-h2",
    refreshAttachmentStatus: null as string | null,
    terminalStatusQueue: [] as string[],
    workflowOwnership: [] as Array<{
      workflowId: string | null;
      status: string;
    }>,
    refreshWorkflowOwnership: [] as Array<{
      workflowId: string | null;
      status: string;
    }>,
    awaitingReviewCheckpoint: null as null | Record<string, unknown>,
    completionResult: {
      persisted: true as boolean,
      status: "completed",
    },
  };
  const writer = {
    write: vi.fn(async () => undefined),
    releaseLock: vi.fn(),
  };
  return {
    timeline,
    state,
    writer,
    createHook: vi.fn(),
    candidateCount: vi.fn(async () => 0),
    runStatus: "running" as string,
    close: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    appendEvent: vi.fn(async () => undefined),
    persistResearchEvent: vi.fn(async () => undefined),
    completeRun: vi.fn(async (input: unknown) => {
      void input;
      return state.completionResult;
    }),
    failRun: vi.fn(async () => undefined),
    markRunning: vi.fn(async (): Promise<{ active: boolean; status: string }> => ({
      active: true,
      status: "running",
    })),
    markAwaiting: vi.fn(async (): Promise<{ persisted: boolean; status: string }> => ({
      persisted: true,
      status: "awaiting_review",
    })),
    startRefresh: vi.fn(async () => {
      timeline.push("start_refresh_h2");
      return { runId: "refresh-h2", status: "queued" };
    }),
    claimInline: vi.fn(async () => true),
    releaseInline: vi.fn(async () => true),
    inventory: vi.fn(async () => {
      timeline.push("inventory_h2_delta");
      return {};
    }),
    analyzeChunk: vi.fn(async () => {
      timeline.push("analyze_one_h2_delta");
      return { remaining: 0 };
    }),
    repairCoverage: vi.fn(async () => ({ repaired: 0 })),
    finalizeCoverage: vi.fn(async () => {
      timeline.push("finalize_h2_coverage");
      return {};
    }),
    completeRefresh: vi.fn(async () => {
      timeline.push("complete_refresh_h2");
      return {};
    }),
    reconcile: vi.fn(async () => {
      timeline.push("apply_h2_fact");
      return {
        appliedFactIds: ["fact-h2-current"],
        appliedHighlightIds: [],
        promotedEvidenceIds: ["evidence-h2"],
        embeddingTelemetry: {
          attempted: 1,
          attempts: 1,
          retried: 0,
          recovered: 0,
          failed: 0,
          failedTargets: [],
        },
      };
    }),
    retryEmbeddingBackfill: vi.fn(async () => ({
      attempted: 0,
      attempts: 0,
      retried: 0,
      recovered: 0,
      failed: 0,
      failedTargets: [],
      qualityStatus: "verified",
    })),
    reconcileStaleness: vi.fn(async () => {
      timeline.push("supersede_h1_fact");
      return {
        supersededProjectFactIds: ["fact-h1-stale"],
        staleHighlightIds: [],
      };
    }),
    assertGenerationCurrent: vi.fn(async () => undefined),
    readinessCheck: vi.fn(async () => ({
      ready: true,
      reason: "ready",
      message: "",
      recovery: "",
      retryable: false,
    })),
    executeArtifactAttempt: vi.fn(),
    runAgent: vi.fn(async (
      input?: { onAgentEvent?: (event: unknown) => void | Promise<void> },
    ): Promise<unknown> => {
      timeline.push("answer_from_h2_memory");
      if (state.emitAgentEvent) {
        await input?.onAgentEvent?.({
          type: "model_call_started",
          iteration: 1,
        });
      }
      return {
        status: "answered" as const,
        answer: [
          "### Current repository intelligence",
          "The H2 revision adds incremental semantic reconciliation while replacing the earlier H1 behavior. [citation:1]",
        ].join("\n"),
        citations: [{
          kind: "project_fact" as const,
          label: "Incremental semantic reconciliation",
          excerpt: "The H2 revision adds incremental semantic reconciliation while replacing the earlier H1 behavior.",
          projectFactId: "fact-h2-current",
        }],
        citationPolicy: "required_inline" as const,
        groundedClaims: [{
          claim: "The H2 revision adds incremental semantic reconciliation while replacing the earlier H1 behavior.",
          citationIndexes: [1],
        }],
        freshness: {
          repository: "arkb75/Workbase",
          commitSha: "2".repeat(40),
          inspectedAt: "2026-07-19T12:00:00.000Z",
          partial: false,
        },
        research: {
          status: "answered" as const,
          answer: "The H2 revision adds incremental semantic reconciliation while replacing the earlier H1 behavior.",
          findings: [],
          citations: [],
          coverageGaps: [],
          warnings: [],
          candidateIds: [],
          generationRunIds: [],
          partial: false,
          exploredEvidence: [],
          coverage: null,
        },
      };
    }),
    agentRunUpdate: vi.fn(async () => ({})),
    agentRunUpdateMany: vi.fn(async () => ({ count: 1 })),
    knowledgeRefreshUpdateMany: vi.fn(async () => ({ count: 1 })),
  };
});

vi.mock("workflow", () => ({
  FatalError: class FatalError extends Error {},
  createHook: mocks.createHook,
  getWorkflowMetadata: () => ({
    workflowRunId: mocks.state.workflowRunId,
    workflowName: "projectChatTurnWorkflow",
    workflowStartedAt: new Date("2026-07-19T12:00:00.000Z"),
    url: "http://localhost/workflow",
  }),
  sleep: mocks.sleep,
  getWritable: () => ({
    getWriter: () => mocks.writer,
    close: mocks.close,
  }),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        $queryRaw: vi.fn(async () => [{
          status: mocks.state.refreshAttachmentStatus ?? mocks.runStatus,
        }]),
        agentRun: {
          findUnique: vi.fn(async () => ({ status: mocks.runStatus })),
          updateMany: mocks.agentRunUpdateMany,
        },
        knowledgeRefreshRun: {
          findUnique: vi.fn(async () => null),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      })),
    agentRun: {
      findUniqueOrThrow: vi.fn(async (input: { select?: { status?: boolean } }) =>
        input?.select?.status
          ? { status: mocks.state.answerStatus ?? mocks.runStatus }
          : {
              id: "run-h2",
              userId: "user-1",
              workItemId: "work-item-1",
              threadId: "thread-1",
              status: "running",
              messages: [{
                id: "message-user-h2",
                role: "user",
                content: mocks.state.currentQuestion,
                sequence: 1,
              }],
              thread: {
                rollingSummary: null,
                messages: mocks.state.threadMessages,
              },
            }),
      findUnique: vi.fn(async (
        input: {
          select?: {
            status?: boolean;
            workflowId?: boolean;
            provisionalResult?: boolean;
          };
        },
      ) => {
        if (input?.select?.workflowId) {
          return mocks.state.workflowOwnership.shift() ?? {
            workflowId: mocks.state.workflowRunId,
            status: mocks.runStatus,
          };
        }
        if (input?.select?.provisionalResult) {
          return mocks.state.awaitingReviewCheckpoint;
        }
        return input?.select?.status
          ? { status: mocks.state.terminalStatusQueue.shift() ?? mocks.runStatus }
          : { result: null };
      }),
      update: mocks.agentRunUpdate,
      updateMany: mocks.agentRunUpdateMany,
    },
    agentRunCandidate: {
      findFirst: vi.fn(async () => null),
      count: mocks.candidateCount,
    },
    knowledgeRefreshRun: {
      findUnique: vi.fn(async () =>
        mocks.state.refreshWorkflowOwnership.shift() ?? {
          workflowId: mocks.state.workflowRunId,
          status: "queued",
        }),
      findUniqueOrThrow: vi.fn(async (input: { select?: { changes?: unknown } }) =>
        input?.select?.changes
          ? { status: "reconciling", warnings: null, changes: [] }
          : {
              id: "refresh-h2",
              status: "completed",
              targetHeads: [{
                sourceId: "source-1",
                repository: "arkb75/Workbase",
                commitSha: "2".repeat(40),
              }],
              coverage: {
                qualityStatus: "verified",
                inspectedFiles: 1,
                eligibleFiles: 1,
              },
              error: null,
              finishedAt: new Date("2026-07-19T12:00:00.000Z"),
            }),
      updateMany: mocks.knowledgeRefreshUpdateMany,
    },
  },
}));

vi.mock("@/src/services/project-chat-store", () => ({
  appendAgentRunEvent: mocks.appendEvent,
  completeAgentRun: mocks.completeRun,
  failAgentRun: mocks.failRun,
  markAgentRunAwaitingReview: mocks.markAwaiting,
  markAgentRunRunning: mocks.markRunning,
}));

vi.mock("@/src/services/chat-highlight-candidate-service", () => ({
  proposeHighlightFromChatContext: vi.fn(async () => null),
}));

vi.mock("@/src/services/artifact-workflow-service", () => ({
  executeArtifactAttempt: mocks.executeArtifactAttempt,
}));

vi.mock("@/src/services/research-event-persistence-service", () => ({
  persistResearchAgentEvent: mocks.persistResearchEvent,
}));

vi.mock("@/src/services/project-chat-agent-service", () => ({
  finalizeProjectChatAfterFactReview: mocks.runAgent,
  runProjectChatAgent: mocks.runAgent,
}));

vi.mock("@/src/services/project-chat-turn-planner-service", () => ({
  ensureProjectChatTurnPlan: vi.fn(async () => ({
    version: "project-chat-turn-plan-v1",
    objective: mocks.state.currentQuestion,
    action: mocks.state.turnPlanAction,
    allowRepositoryResearch: true,
    knowledgeQueries: [mocks.state.currentQuestion],
    outputFormat: "follow the user's requested format",
    outputRequirements: [],
    reasonCodes: ["semantic_test_fixture"],
    confidence: 1,
    generationRunId: "plan-run-1",
  })),
}));

vi.mock("@/src/services/knowledge-refresh-service", () => ({
  isKnowledgeRefreshPartial: () => false,
  startKnowledgeRefresh: mocks.startRefresh,
  knowledgeRefreshService: {
    claimInline: mocks.claimInline,
    releaseInline: mocks.releaseInline,
    inventory: mocks.inventory,
    analyzeChunk: mocks.analyzeChunk,
    repairCoverage: mocks.repairCoverage,
    finalizeCoverage: mocks.finalizeCoverage,
    complete: mocks.completeRefresh,
    fail: vi.fn(async () => undefined),
  },
}));

vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  assertKnowledgeRefreshGenerationCurrent: mocks.assertGenerationCurrent,
  knowledgeReconciliationService: {
    reconcile: mocks.reconcile,
    retryEmbeddingBackfill: mocks.retryEmbeddingBackfill,
  },
}));

vi.mock("@/src/services/knowledge-staleness-service", () => ({
  knowledgeStalenessService: {
    reconcile: mocks.reconcileStaleness,
  },
}));

vi.mock("@/src/services/runtime-readiness-service", () => ({
  runtimeReadinessService: {
    check: mocks.readinessCheck,
  },
}));

import {
  artifactGenerationWorkflow,
  projectChatTurnWorkflow,
  replayedAppliedKnowledgeIds,
  repositoryKnowledgeRefreshDebounceDelay,
  repositoryKnowledgeRefreshWorkflow,
} from "@/workflows/project-chat";

describe("project chat latest-commit freshness orchestration", () => {
  it("debounces only proactive webhook refreshes before expensive work", () => {
    expect(repositoryKnowledgeRefreshDebounceDelay("webhook_push")).toBe("5s");
    expect(repositoryKnowledgeRefreshDebounceDelay("chat_freshness")).toBeNull();
    expect(repositoryKnowledgeRefreshDebounceDelay("manual")).toBeNull();
  });

  it("does not reconstruct retired or quarantined knowledge as applied on replay", () => {
    expect(replayedAppliedKnowledgeIds([
      { entityKind: "project_fact", action: "revalidated", projectFactId: "fact-current", highlightId: null, evidenceItemId: null },
      { entityKind: "project_fact", action: "retired", projectFactId: "fact-retired", highlightId: null, evidenceItemId: null },
      { entityKind: "highlight", action: "updated", projectFactId: null, highlightId: "highlight-current", evidenceItemId: null },
      { entityKind: "highlight", action: "quarantined", projectFactId: null, highlightId: "highlight-quarantined", evidenceItemId: null },
      { entityKind: "evidence", action: "created", projectFactId: null, highlightId: null, evidenceItemId: "evidence-current" },
    ])).toEqual({
      appliedFactIds: ["fact-current"],
      appliedHighlightIds: ["highlight-current"],
      promotedEvidenceIds: ["evidence-current"],
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.timeline.length = 0;
    mocks.state.emitAgentEvent = false;
    mocks.state.answerStatus = null;
    mocks.state.currentQuestion =
      "Summarize my strongest accomplishments and make sure your information is up to date.";
    mocks.state.turnPlanAction = "refresh_then_answer";
    mocks.state.threadMessages = [];
    mocks.state.workflowRunId = "wrun-h2";
    mocks.state.refreshAttachmentStatus = null;
    mocks.state.terminalStatusQueue = [];
    mocks.state.workflowOwnership = [];
    mocks.state.refreshWorkflowOwnership = [];
    mocks.state.awaitingReviewCheckpoint = null;
    mocks.state.completionResult = {
      persisted: true,
      status: "completed",
    };
    mocks.runStatus = "running";
    mocks.sleep.mockResolvedValue(undefined);
    mocks.agentRunUpdateMany.mockResolvedValue({ count: 1 });
    mocks.knowledgeRefreshUpdateMany.mockResolvedValue({ count: 1 });
    mocks.candidateCount.mockReset();
    mocks.candidateCount.mockResolvedValue(0);
    mocks.createHook.mockReset();
    mocks.writer.write.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.appendEvent.mockResolvedValue(undefined);
    mocks.markRunning.mockResolvedValue({
      active: true,
      status: "running",
    });
    mocks.markAwaiting.mockResolvedValue({
      persisted: true,
      status: "awaiting_review",
    });
    mocks.readinessCheck.mockResolvedValue({
      ready: true,
      reason: "ready",
      message: "",
      recovery: "",
      retryable: false,
    });
  });

  it("refreshes, reconciles stale H1 knowledge, and only then answers the exact accomplishments prompt from H2 memory", async () => {
    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    expect(mocks.startRefresh).toHaveBeenCalledWith({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "chat_freshness",
      idempotencyKey: "agent-run:run-h2:freshness",
    });
    expect(mocks.analyzeChunk).toHaveBeenCalledOnce();
    expect(mocks.timeline).toEqual([
      "start_refresh_h2",
      "inventory_h2_delta",
      "analyze_one_h2_delta",
      "finalize_h2_coverage",
      "apply_h2_fact",
      "supersede_h1_fact",
      "complete_refresh_h2",
      "answer_from_h2_memory",
    ]);

    expect(mocks.completeRun).toHaveBeenCalledOnce();
    const completion = mocks.completeRun.mock.calls[0]![0] as {
      content: string;
      citations: Array<{ kind: string; projectFactId?: string }>;
    };
    expect(completion.content).toContain("H2 revision");
    expect(completion.content).not.toContain("H1 behavior is current");
    expect(completion.citations).toEqual([
      expect.objectContaining({
        kind: "project_fact",
        projectFactId: "fact-h2-current",
      }),
    ]);
    expect(completion.citations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "github_file" })]),
    );
    expect(JSON.stringify(completion)).not.toContain("fact-h1-stale");
    expect(mocks.failRun).not.toHaveBeenCalled();
  });

  it("runs the latest-head barrier for a standalone epistemic freshness follow-up", async () => {
    mocks.state.currentQuestion = "make sure your understanding is up to date";

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    expect(mocks.startRefresh).toHaveBeenCalledWith({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "chat_freshness",
      idempotencyKey: "agent-run:run-h2:freshness",
    });
    expect(mocks.timeline.at(-1)).toBe("answer_from_h2_memory");
  });

  it("does not recursively refresh for an explicit refresh-status question", async () => {
    mocks.state.currentQuestion = "What is the current status of the repository refresh?";
    mocks.state.turnPlanAction = "answer";

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    expect(mocks.startRefresh).not.toHaveBeenCalled();
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.runAgent).toHaveBeenCalledOnce();
  });

  it("repairs failed embeddings when reusing a completed latest-commit refresh", async () => {
    mocks.startRefresh.mockResolvedValueOnce({
      runId: "refresh-h2",
      status: "completed",
    });
    mocks.retryEmbeddingBackfill.mockResolvedValueOnce({
      attempted: 1,
      attempts: 1,
      retried: 0,
      recovered: 0,
      failed: 0,
      failedTargets: [],
      qualityStatus: "verified",
    });

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    expect(mocks.retryEmbeddingBackfill).toHaveBeenCalledWith("refresh-h2");
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.runAgent).toHaveBeenCalledOnce();
  });

  it("self-attaches its workflow ID from the exact start reservation before doing expensive work", async () => {
    mocks.state.workflowOwnership = [
      {
        workflowId: "starting:1784487600000:starter-a",
        status: "queued",
      },
    ];

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    expect(mocks.agentRunUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "run-h2",
        workflowId: "starting:1784487600000:starter-a",
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: { workflowId: "wrun-h2" },
    });
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.readinessCheck).toHaveBeenCalledOnce();
    expect(mocks.startRefresh).toHaveBeenCalledOnce();
    expect(mocks.runAgent).toHaveBeenCalledOnce();
  });

  it("does not attach or claim a refresh when cancellation wins after refresh creation", async () => {
    mocks.state.refreshAttachmentStatus = "cancelled";

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.startRefresh).toHaveBeenCalledOnce();
    expect(mocks.claimInline).not.toHaveBeenCalled();
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.analyzeChunk).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("releases an acquired inline refresh owner when cancellation wins before inventory", async () => {
    // The workflow no longer performs redundant status-only steps before the
    // refresh. This value is consumed by the authoritative pre-inventory
    // cancellation fence inside runRequiredKnowledgeRefresh.
    mocks.state.terminalStatusQueue = ["running", "cancelled"];

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.claimInline).toHaveBeenCalledWith({
      runId: "refresh-h2",
      ownerToken: "inline-agent:run-h2",
    }, expect.anything());
    expect(mocks.releaseInline).toHaveBeenCalledWith({
      runId: "refresh-h2",
      ownerToken: "inline-agent:run-h2",
    });
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("lets a repository refresh workflow self-attach before repository work", async () => {
    mocks.state.refreshWorkflowOwnership = [{
      workflowId: "starting:1784487600000:refresh-starter",
      status: "queued",
    }];

    await expect(repositoryKnowledgeRefreshWorkflow("refresh-h2")).resolves.toEqual(
      expect.objectContaining({ appliedFactIds: ["fact-h2-current"] }),
    );

    expect(mocks.knowledgeRefreshUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "refresh-h2",
        workflowId: "starting:1784487600000:refresh-starter",
        status: {
          in: [
            "queued",
            "inventorying",
            "analyzing",
            "routing",
            "semantic_analysis",
            "auditing",
            "reconciling",
          ],
        },
      },
      data: { workflowId: "wrun-h2" },
    });
    expect(mocks.readinessCheck).toHaveBeenCalledOnce();
    expect(mocks.inventory).toHaveBeenCalledOnce();
  });

  it("does no repository work when a refresh workflow loses its self-attachment CAS", async () => {
    mocks.state.refreshWorkflowOwnership = [
      {
        workflowId: "starting:1784487600000:refresh-starter",
        status: "queued",
      },
      { workflowId: "wrun-refresh-winner", status: "queued" },
    ];
    mocks.knowledgeRefreshUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(repositoryKnowledgeRefreshWorkflow("refresh-h2")).resolves.toEqual({
      status: "superseded",
      replayed: true,
      attachedWorkflowId: "wrun-refresh-winner",
    });

    expect(mocks.readinessCheck).not.toHaveBeenCalled();
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.analyzeChunk).not.toHaveBeenCalled();
  });

  it("does no repository work when refresh cancellation beats workflow ownership", async () => {
    mocks.state.refreshWorkflowOwnership = [{
      workflowId: "starting:1784487600000:refresh-starter",
      status: "cancelled",
    }];

    await expect(repositoryKnowledgeRefreshWorkflow("refresh-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.knowledgeRefreshUpdateMany).not.toHaveBeenCalled();
    expect(mocks.readinessCheck).not.toHaveBeenCalled();
    expect(mocks.inventory).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "chat",
      run: () => projectChatTurnWorkflow("run-h2"),
    },
    {
      name: "artifact",
      run: () => artifactGenerationWorkflow("run-h2"),
    },
  ])(
    "lets the winning takeover displace a delayed orphan $name workflow before expensive work",
    async ({ run }) => {
      mocks.state.workflowRunId = "wrun-orphan";
      mocks.state.workflowOwnership = [
        {
          workflowId: "starting:1784487600000:starter-a",
          status: "queued",
        },
        {
          workflowId: "wrun-winner",
          status: "queued",
        },
      ];
      mocks.agentRunUpdateMany.mockResolvedValueOnce({ count: 0 });

      await expect(run()).resolves.toEqual({
        status: "superseded",
        replayed: true,
        attachedWorkflowId: "wrun-winner",
      });

      expect(mocks.agentRunUpdateMany).toHaveBeenCalledOnce();
      expect(mocks.sleep).not.toHaveBeenCalled();
      expect(mocks.readinessCheck).not.toHaveBeenCalled();
      expect(mocks.startRefresh).not.toHaveBeenCalled();
      expect(mocks.inventory).not.toHaveBeenCalled();
      expect(mocks.runAgent).not.toHaveBeenCalled();
      expect(mocks.executeArtifactAttempt).not.toHaveBeenCalled();
      expect(mocks.markRunning).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "chat",
      run: () => projectChatTurnWorkflow("run-h2"),
    },
    {
      name: "artifact",
      run: () => artifactGenerationWorkflow("run-h2"),
    },
  ])(
    "does no paid $name work when cancellation wins the mark-running transition",
    async ({ run }) => {
      mocks.state.currentQuestion = "Explain the architecture.";
      mocks.state.turnPlanAction = "answer";
      mocks.markRunning.mockResolvedValueOnce({
        active: false,
        status: "cancelled",
      });

      await expect(run()).resolves.toEqual({
        status: "cancelled",
        replayed: true,
      });

      expect(mocks.markRunning).toHaveBeenCalledOnce();
      expect(mocks.runAgent).not.toHaveBeenCalled();
      expect(mocks.executeArtifactAttempt).not.toHaveBeenCalled();
      expect(mocks.inventory).not.toHaveBeenCalled();
      expect(mocks.analyzeChunk).not.toHaveBeenCalled();
    },
  );

  it.each([
    "completed",
    "insufficient_context",
    "failed",
    "cancelled",
  ])("does not repeat refresh or answer work when a %s run is replayed", async (status) => {
    mocks.runStatus = status;

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status,
      replayed: true,
    });

    expect(mocks.readinessCheck).not.toHaveBeenCalled();
    expect(mocks.startRefresh).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.markRunning).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it("reuses a structurally valid awaiting-review checkpoint without repeating routing, research, candidates, or citations", async () => {
    mocks.state.currentQuestion = "Explain the repository architecture.";
    mocks.state.turnPlanAction = "answer";
    mocks.runStatus = "awaiting_review";
    mocks.state.answerStatus = "awaiting_review";
    const provisionalContent =
      "Repository research found a reviewable architecture fact. [citation:1]";
    mocks.state.awaitingReviewCheckpoint = {
      status: "awaiting_review",
      result: {
        status: "awaiting_review",
        candidateIds: ["candidate-1"],
        coverageGaps: [],
      },
      provisionalResult: {
        content: provisionalContent,
        citations: [{
          ordinal: 1,
          kind: "project_fact",
          label: "Reviewable architecture fact",
          projectFactId: "fact-1",
        }],
        capturedAt: "2026-07-19T12:00:00.000Z",
      },
      candidates: [{
        id: "candidate-1",
        kind: "new_project_fact",
        batchNumber: 1,
        projectFactId: "fact-1",
      }],
      messages: [{
        status: "awaiting_review",
        content: provisionalContent,
        citations: [{
          ordinal: 1,
          kind: "project_fact",
          label: "Reviewable architecture fact",
          projectFactId: "fact-1",
        }],
      }],
    };
    let resolveReview!: (value: { reviewed: true }) => void;
    const review = new Promise<{ reviewed: true }>((resolve) => {
      resolveReview = resolve;
    }) as Promise<{ reviewed: true }> & { [Symbol.dispose]: () => void };
    Object.defineProperty(review, Symbol.dispose, {
      value: vi.fn(),
      configurable: true,
    });
    mocks.createHook.mockReturnValue(review);
    mocks.candidateCount
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    const workflow = projectChatTurnWorkflow("run-h2");
    await vi.waitFor(() => expect(mocks.createHook).toHaveBeenCalledOnce());

    // The durable checkpoint is read-only. No pre-review transition, agent,
    // candidate, citation, or completion work is repeated.
    expect(mocks.markRunning).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.markAwaiting).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();

    resolveReview({ reviewed: true });
    await expect(workflow).resolves.toEqual({ status: "completed" });

    // Only the legitimate post-review finalizer runs after the hook resolves.
    expect(mocks.runAgent).toHaveBeenCalledOnce();
    expect(mocks.runAgent).toHaveBeenCalledWith(expect.objectContaining({
      allowResearch: false,
    }));
    expect(mocks.markAwaiting).not.toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalledOnce();
  });

  it("returns authoritative cancellation when it wins after fact materialization but before the review checkpoint", async () => {
    mocks.state.currentQuestion = "Explain the repository architecture.";
    mocks.state.turnPlanAction = "answer";
    mocks.runAgent.mockResolvedValueOnce({
      status: "awaiting_review",
      answer: "A provisional architecture fact awaits review. [citation:1]",
      citations: [{
        kind: "project_fact",
        label: "Provisional architecture fact",
        excerpt: "A provisional architecture fact awaits review.",
        projectFactId: "fact-1",
      }],
      citationPolicy: "required_inline",
      groundedClaims: [{
        claim: "A provisional architecture fact awaits review.",
        citationIndexes: [1],
      }],
      freshness: null,
      research: {
        status: "awaiting_review",
        answer: "A provisional architecture fact awaits review.",
        findings: [],
        citations: [],
        coverageGaps: [],
        warnings: [],
        candidateIds: ["candidate-1"],
        generationRunIds: [],
        partial: false,
        exploredEvidence: [],
        coverage: null,
      },
    });
    mocks.markAwaiting.mockResolvedValueOnce({
      persisted: false,
      status: "cancelled",
    });

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.markAwaiting).toHaveBeenCalledOnce();
    expect(mocks.createHook).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      message: "Repository research found project facts. Waiting for every review decision.",
    }));
  });

  it("keeps chat cancellation authoritative when an in-flight step throws afterward", async () => {
    mocks.state.currentQuestion = "Explain the repository architecture.";
    mocks.state.turnPlanAction = "answer";
    mocks.runAgent.mockImplementationOnce(async () => {
      mocks.runStatus = "cancelled";
      throw new Error("provider returned after cancellation");
    });

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it("keeps artifact cancellation authoritative when an in-flight attempt throws afterward", async () => {
    mocks.state.currentQuestion = "Write a concise project summary.";
    mocks.state.turnPlanAction = "answer";
    mocks.executeArtifactAttempt.mockImplementationOnce(async () => {
      mocks.runStatus = "cancelled";
      throw new Error("artifact provider returned after cancellation");
    });

    await expect(artifactGenerationWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it("keeps a successful answer successful when durable progress and stream delivery fail", async () => {
    mocks.appendEvent.mockRejectedValue(new Error("event store unavailable"));
    mocks.writer.write.mockRejectedValue(new Error("stream disconnected"));
    mocks.close.mockRejectedValue(new Error("stream already closed"));
    mocks.persistResearchEvent.mockRejectedValue(new Error("agent event persistence unavailable"));
    mocks.state.emitAgentEvent = true;

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    expect(mocks.runAgent).toHaveBeenCalledOnce();
    expect(mocks.persistResearchEvent).toHaveBeenCalledOnce();
    expect(mocks.completeRun).toHaveBeenCalledOnce();
    expect(mocks.failRun).not.toHaveBeenCalled();
  });

  it("replays a failed turn to a follow-up using only its sanitized failure envelope", async () => {
    mocks.state.currentQuestion = "What happened, and what should I do next?";
    mocks.state.turnPlanAction = "answer";
    mocks.state.threadMessages = [
      {
        id: "message-user-h2",
        agentRunId: "run-h2",
        sequence: 3,
        role: "user",
        status: "completed",
        content: mocks.state.currentQuestion,
        metadata: null,
        citations: [],
        agentRun: { error: null },
      },
      {
        id: "message-assistant-h1",
        agentRunId: "run-h1",
        sequence: 2,
        role: "assistant",
        status: "failed",
        content: "Raw provider failure: ghp_do_not_replay. Internal trace follows.",
        metadata: {
          failureCode: "model_provider_unavailable",
          recovery: "Retry the request after checking the Bedrock service.",
        },
        citations: [{
          ordinal: 1,
          kind: "github_file",
          label: "Untrusted failed-run source",
        }],
        agentRun: {
          error: {
            code: "model_provider_unavailable",
            stage: "Running project chat",
            message: "Raw provider failure: ghp_do_not_replay.",
            recovery: "Provider-only recovery detail.",
          },
        },
      },
      {
        id: "message-user-h1",
        agentRunId: "run-h1",
        sequence: 1,
        role: "user",
        status: "completed",
        content: "Inspect the current repository architecture.",
        metadata: null,
        citations: [],
        agentRun: {
          error: {
            code: "model_provider_unavailable",
            stage: "Running project chat",
          },
        },
      },
    ];

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    const input = mocks.runAgent.mock.calls[0]![0] as unknown as {
      question: string;
      history: Array<{
        role: "user" | "assistant";
        content: string;
        citations: unknown[];
      }>;
    };
    expect(input.question).toBe("What happened, and what should I do next?");
    expect(input.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(input.history[1]).toEqual({
      id: "message-assistant-h1",
      role: "assistant",
      content: [
        "The previous assistant turn failed.",
        "Failure code: model_provider_unavailable.",
        "Stage: Running project chat.",
        "Recovery: Retry the request after checking the Bedrock service.",
      ].join(" "),
      citations: [],
    });
    expect(JSON.stringify(input.history)).not.toContain("ghp_do_not_replay");
    expect(JSON.stringify(input.history)).not.toContain("Provider-only");
    expect(JSON.stringify(input.history)).not.toContain("Untrusted failed-run source");
  });

  it("drops both sides of a legacy failed turn before retrying when no safe envelope exists", async () => {
    mocks.state.currentQuestion = "Retry that request.";
    mocks.state.turnPlanAction = "answer";
    mocks.state.threadMessages = [
      {
        id: "message-user-h2",
        agentRunId: "run-h2",
        sequence: 3,
        role: "user",
        status: "completed",
        content: mocks.state.currentQuestion,
        metadata: null,
        citations: [],
        agentRun: { error: null },
      },
      {
        id: "message-assistant-h1",
        agentRunId: "run-h1",
        sequence: 2,
        role: "assistant",
        status: "failed",
        content: "Unstructured legacy provider error with hidden details.",
        metadata: null,
        citations: [],
        agentRun: {
          error: {
            message: "Unstructured legacy provider error with hidden details.",
          },
        },
      },
      {
        id: "message-user-h1",
        agentRunId: "run-h1",
        sequence: 1,
        role: "user",
        status: "completed",
        content: "Read every repository file.",
        metadata: null,
        citations: [],
        agentRun: { error: null },
      },
    ];

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    const input = mocks.runAgent.mock.calls[0]![0] as unknown as {
      history: Array<{ role: "user" | "assistant"; content: string }>;
    };
    expect(input.history).toEqual([]);
    expect(JSON.stringify(input.history)).not.toContain("legacy provider error");
    expect(JSON.stringify(input.history)).not.toContain("Read every repository file");
  });

  it("keeps cancelled history pair-aligned without replaying interrupted content", async () => {
    mocks.state.currentQuestion = "Can you answer a narrower version instead?";
    mocks.state.turnPlanAction = "answer";
    mocks.state.threadMessages = [
      {
        id: "message-user-h2",
        agentRunId: "run-h2",
        sequence: 3,
        role: "user",
        status: "completed",
        content: mocks.state.currentQuestion,
        metadata: null,
        citations: [],
        agentRun: { error: null },
      },
      {
        id: "message-assistant-h1",
        agentRunId: "run-h1",
        sequence: 2,
        role: "assistant",
        status: "cancelled",
        content: "Partially generated answer that must not be replayed.",
        metadata: { outcome: "cancelled" },
        citations: [{
          ordinal: 1,
          kind: "evidence",
          label: "Partial source",
        }],
        agentRun: { error: null },
      },
      {
        id: "message-user-h1",
        agentRunId: "run-h1",
        sequence: 1,
        role: "user",
        status: "completed",
        content: "Give me a comprehensive repository assessment.",
        metadata: null,
        citations: [],
        agentRun: { error: null },
      },
    ];

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "completed",
    });

    const input = mocks.runAgent.mock.calls[0]![0] as unknown as {
      history: Array<{
        role: "user" | "assistant";
        content: string;
        citations: unknown[];
      }>;
    };
    expect(input.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(input.history[1]).toEqual({
      id: "message-assistant-h1",
      role: "assistant",
      content: "The previous assistant turn was cancelled before completion.",
      citations: [],
    });
    expect(JSON.stringify(input.history)).not.toContain("Partially generated answer");
    expect(JSON.stringify(input.history)).not.toContain("Partial source");
  });

  it("returns the authoritative cancelled state when cancellation wins the completion race", async () => {
    mocks.state.completionResult = {
      persisted: false,
      status: "cancelled",
    };

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.completeRun).toHaveBeenCalledOnce();
    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      message: "Answer grounded and citations attached.",
    }));
  });

  it("returns cancellation when it wins after refresh but before answer generation", async () => {
    mocks.state.answerStatus = "cancelled";

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.markRunning).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "Project chat was cancelled.",
    }));
    expect(mocks.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      message: "Project context was not sufficient for a grounded answer.",
    }));
  });

  it.each([
    "runtime_schema_mismatch",
    "database_schema_out_of_date",
  ] as const)(
    "records %s failures at the application-readiness stage for chat and artifact workflows",
    async (reason) => {
      mocks.readinessCheck.mockResolvedValue({
        ready: false,
        reason,
        message: "The generated client and deployed database do not match.",
        recovery: "Apply migrations.",
        retryable: false,
      });

      await expect(projectChatTurnWorkflow("run-h2")).resolves.toMatchObject({
        status: "failed",
      });
      expect(mocks.failRun).toHaveBeenLastCalledWith(expect.objectContaining({
        runId: "run-h2",
        failure: expect.objectContaining({
          code: reason,
          stage: "Checking application readiness",
          retryable: false,
        }),
      }));

      vi.clearAllMocks();
      mocks.runStatus = "running";
      mocks.close.mockResolvedValue(undefined);
      mocks.appendEvent.mockResolvedValue(undefined);
      mocks.readinessCheck.mockResolvedValue({
        ready: false,
        reason,
        message: "The generated client and deployed database do not match.",
        recovery: "Apply migrations.",
        retryable: false,
      });

      await expect(artifactGenerationWorkflow("run-h2")).resolves.toMatchObject({
        status: "failed",
      });
      expect(mocks.failRun).toHaveBeenLastCalledWith(expect.objectContaining({
        runId: "run-h2",
        failure: expect.objectContaining({
          code: reason,
          stage: "Checking application readiness",
          retryable: false,
        }),
      }));
    },
  );

  it("terminalizes an insufficient-context answer as a valid conversational outcome", async () => {
    mocks.runAgent.mockResolvedValueOnce({
      status: "insufficient_context",
      answer: "The current project memory does not establish production request volume.",
      coverageGaps: ["No production telemetry is attached."],
      partial: false,
    });

    await expect(projectChatTurnWorkflow("run-h2")).resolves.toEqual({
      status: "insufficient_context",
    });

    expect(mocks.failRun).toHaveBeenCalledWith({
      runId: "run-h2",
      message: "The current project memory does not establish production request volume.",
      insufficient: true,
    });
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it("terminalizes an artifact run when every bounded attempt requests more research", async () => {
    mocks.executeArtifactAttempt.mockResolvedValue({
      status: "retry_research",
    });

    await expect(artifactGenerationWorkflow("run-h2")).resolves.toEqual({
      status: "insufficient_context",
      message: "The artifact workflow finished without enough approved context.",
    });

    expect(mocks.executeArtifactAttempt).toHaveBeenCalledTimes(3);
    expect(mocks.failRun).toHaveBeenCalledWith({
      runId: "run-h2",
      message: "The artifact workflow finished without enough approved context.",
      insufficient: true,
    });
  });

  it("propagates cancellation from an active artifact attempt", async () => {
    mocks.executeArtifactAttempt.mockResolvedValue({
      status: "cancelled",
      message: "The artifact run was cancelled.",
      replayed: true,
    });

    await expect(artifactGenerationWorkflow("run-h2")).resolves.toEqual({
      status: "cancelled",
      message: "The artifact run was cancelled.",
      replayed: true,
    });

    expect(mocks.executeArtifactAttempt).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: "The artifact run was cancelled.",
    }));
    expect(mocks.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      message: "Project context was not sufficient for a grounded answer.",
    }));
  });
});
