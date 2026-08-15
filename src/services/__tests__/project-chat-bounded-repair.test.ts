import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BedrockConverseAgentEvent,
  BedrockConverseTool,
} from "@/src/lib/bedrock-converse-agent";

const mocks = vi.hoisted(() => ({
  agentRunFind: vi.fn(),
  agentRun: vi.fn(),
  auditRun: vi.fn(),
  verify: vi.fn(),
  appendEvent: vi.fn(),
  retrieve: vi.fn(),
  inspectRepository: vi.fn(),
  disposeRepository: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    agentRun: { findFirstOrThrow: mocks.agentRunFind },
  },
}));

vi.mock("@/src/services/bedrock-runtime", () => ({
  createTextConverseAgent: vi.fn(() => ({ run: mocks.agentRun })),
}));

vi.mock("@/src/services/project-chat-model-audit-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/project-chat-model-audit-service")>()),
  runAuditedProjectChatModel: mocks.auditRun,
}));

vi.mock("@/src/services/project-chat-answer-verification-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/project-chat-answer-verification-service")>()),
  verifyModelLedProjectChatAnswer: mocks.verify,
}));

vi.mock("@/src/services/project-chat-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/project-chat-store")>()),
  appendAgentRunEvent: mocks.appendEvent,
}));

vi.mock("@/src/services/project-knowledge-retrieval-service", () => ({
  projectKnowledgeRetrievalService: { retrieve: mocks.retrieve },
}));

vi.mock("@/src/services/project-chat-repository-inspection-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/project-chat-repository-inspection-service")>()),
  ProjectChatRepositoryInspector: class {
    inspect = mocks.inspectRepository;
    dispose = mocks.disposeRepository;
  },
}));

import { executeModelLedProjectChatAgent } from "@/src/services/project-chat-model-agent-service";

const usage = {
  inputTokens: 1_000,
  outputTokens: 300,
  totalTokens: 1_300,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

function verificationFixture(input: {
  action?: "keep_direct" | "keep_inference" | "qualify" | "repair_citation" | "research" | "remove_unfounded";
  support?: "direct" | "reasonable_inference" | "ambiguous" | "unfounded";
  quote?: string;
  explanation?: string;
  instructionSatisfied?: boolean;
  answerUseful?: boolean;
  researchObjective?: string | null;
  recommendedCapabilities?: string[];
  generationRunId?: string;
  citationIndexes?: number[];
}) {
  const action = input.action ?? "keep_direct";
  const support = input.support ?? "direct";
  const needsPremise = ["ambiguous", "unfounded"].includes(support);
  return {
    requiresProjectCitations: true,
    instructionSatisfied: input.instructionSatisfied ?? true,
    formatSatisfied: true,
    answerUseful: input.answerUseful ?? true,
    researchObjective: input.researchObjective ?? null,
    recommendedCapabilities: input.recommendedCapabilities ?? [],
    claimLedger: {
      version: "project-chat-claim-ledger-v1",
      entries: [{
        id: "claim_1",
        quote: input.quote ?? "The robotics controller is at the current imported revision.",
        centrality: "central",
        support,
        action,
        citationIndexes: input.citationIndexes ?? [1],
        missingOrContradictedPremise: needsPremise
          ? input.explanation ?? "The necessary premise is not established."
          : null,
        rationale: input.explanation ?? "The current source supports this claim.",
        confidence: "high",
      }],
    },
    issues: [],
    generationRunId: input.generationRunId ?? "verification-fixture",
    mechanicalIssues: [],
  };
}

function modelResult(text: string, toolNames: string[]) {
  return {
    text,
    assistantMessage: { role: "assistant" as const, content: [{ text }] },
    messages: [],
    stopReason: "end_turn" as const,
    iterations: 1,
    toolCalls: toolNames.length,
    usage,
    events: toolNames.map((toolName, index) => ({
      type: "tool_call_completed" as const,
      iteration: 1,
      toolCall: index + 1,
      toolUseId: `tool-${index + 1}`,
      toolName,
      outcome: "success" as const,
      durationMs: 1,
      output: null,
    })),
    provider: "mock",
    modelId: "mock",
    requestIds: ["request-1"],
  };
}

function largeCoverage() {
  const paths = Array.from({ length: 393 }, (_, index) => `src/path-${index}.ts`);
  return [{
    repository: "acme/robotics-controller",
    commitSha: "a".repeat(40),
    totalPaths: 437,
    analyzedPaths: 393,
    excludedPaths: 44,
    semanticPaths: 18,
    coverageStatus: "complete",
    semanticCoverageStatus: "complete",
    capabilityCoverageStatus: "verified",
    coverageGaps: [],
    dimensions: {
      inventory: "complete",
      staticAnalysis: "complete",
      semanticAnalysis: "complete",
      capabilityCoverage: "verified",
    },
    targets: Array.from({ length: 20 }, (_, index) => ({
      key: `capability_${index}`,
      label: `Capability ${index}`,
      status: "semantic_verified",
      paths,
      unresolvedQuestions: Array.from(
        { length: 20 },
        (_, question) => `Internal question ${index}-${question}`,
      ),
    })),
  }];
}

describe("project-chat bounded repair regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appendEvent.mockResolvedValue(null);
    mocks.disposeRepository.mockResolvedValue(undefined);
    mocks.inspectRepository.mockResolvedValue({
      status: "completed",
      snapshot: {
        sourceId: "source-1",
        repository: "acme/robotics-controller",
        commitSha: "a".repeat(40),
        defaultBranch: "main",
        committedAt: "2026-08-13T06:00:00.000Z",
        commitUrl: `https://github.com/acme/robotics-controller/commit/${"a".repeat(40)}`,
      },
      results: [{
        args: ["log", "--merges", "--oneline", "-10"],
        status: "success",
        exitCode: 0,
        evidenceId: "evidence-1234567890",
        outputHash: "f".repeat(64),
        totalBytes: 35,
        totalLines: 2,
        segments: [{
          evidenceId: "evidence-1234567890",
          segmentId: "segment-1",
          sourceId: "source-1",
          repository: "acme/robotics-controller",
          commitSha: "a".repeat(40),
          args: ["log", "--merges", "--oneline", "-10"],
          command: "git log --merges --oneline -10",
          excerpt: "aaaa newest merge\nbbbb prior merge",
          excerptHash: "e".repeat(64),
          outputHash: "f".repeat(64),
          startLine: 1,
          endLine: 2,
          totalLines: 2,
          totalBytes: 35,
          truncated: false,
        }],
        truncated: false,
      }],
      expansions: [],
      usage: { queries: 1, expansions: 0, visibleBytes: 35 },
      remainingQueryBudget: 9,
    });
    mocks.retrieve.mockResolvedValue({
      hits: [{
        kind: "project_fact",
        authority: "project_fact",
        title: "Robotics controller repository snapshot",
        content: `acme/robotics-controller is validated through ${"a".repeat(40)}.`,
        citations: [{
          kind: "evidence",
          label: "Robotics controller repository state",
          excerpt: `acme/robotics-controller at ${"a".repeat(40)}`,
        }],
      }],
      warnings: [],
    });
    mocks.agentRunFind.mockResolvedValue({
      workItem: {
        title: "Robotics controller",
        type: "project",
        description: "",
        sources: [{
          id: "source-1",
          type: "github_repo",
          label: "acme/robotics-controller",
          metadata: {},
          updatedAt: new Date("2026-08-13T06:00:00.000Z"),
        }],
      },
      candidates: [],
      knowledgeRefreshRun: {
        id: "refresh-1",
        status: "completed",
        qualityStatus: "verified",
        targetHeads: [{
          sourceId: "source-1",
          repository: "acme/robotics-controller",
          branch: "main",
          commitSha: "a".repeat(40),
          resolvedAt: "2026-08-13T06:00:00.000Z",
        }],
        coverage: largeCoverage(),
        finishedAt: new Date("2026-08-13T06:00:00.000Z"),
        updatedAt: new Date("2026-08-13T06:00:00.000Z"),
      },
    });
    let auditAttempt = 0;
    mocks.auditRun.mockImplementation(async (input) => {
      auditAttempt += 1;
      const executed = await input.execute();
      return {
        generationRunId: `answer-generation-${auditAttempt}`,
        replayed: false,
        checkpoint: {
          version: "project-chat-model-checkpoint-v10",
          answer: executed.result.text,
          catalog: executed.checkpoint.catalog,
          entries: executed.checkpoint.entries,
          research: executed.checkpoint.research,
          control: executed.checkpoint.control,
          toolNames: executed.result.events
            .filter((event: BedrockConverseAgentEvent) =>
              event.type === "tool_call_completed"
            )
            .map((event: Extract<BedrockConverseAgentEvent, {
              type: "tool_call_completed";
            }>) => event.toolName),
        },
      };
    });
    mocks.verify
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: null,
        recommendedCapabilities: [],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "Robotics controller is at the current imported revision.",
            centrality: "central",
            support: "direct",
            action: "repair_citation",
            citationIndexes: [1],
            missingOrContradictedPremise: null,
            rationale: "The source supports the row but its citation attachment needs repair.",
            confidence: "high",
          }, {
            id: "claim_2",
            quote: "Robotics controller is the attached project source.",
            centrality: "central",
            support: "direct",
            action: "keep_direct",
            citationIndexes: [1],
            missingOrContradictedPremise: null,
            rationale: "The attached source record directly establishes the project source.",
            confidence: "high",
          }],
        },
        issues: [{
          code: "uncited_project_claim",
          explanation: "Attach the source citation to the repository row.",
          candidateCitationIndexes: [1],
        }],
        generationRunId: "verification-1",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: null,
        recommendedCapabilities: [],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "Robotics controller is at the current imported revision.",
            centrality: "central",
            support: "direct",
            action: "keep_direct",
            citationIndexes: [1],
            missingOrContradictedPremise: null,
            rationale: "The current repository source supports the row.",
            confidence: "high",
          }],
        },
        issues: [],
        generationRunId: "verification-2",
        mechanicalIssues: [],
      });
    let modelAttempt = 0;
    mocks.agentRun.mockImplementation(async (input) => {
      modelAttempt += 1;
      if (modelAttempt === 1) {
        const inspectionTool = input.tools.find((tool: BedrockConverseTool) =>
          tool.name === "inspect_project"
        );
        expect(inspectionTool?.jsonSchema).toMatchObject({
          properties: {
            knowledgeQueries: {
              items: expect.any(Object),
            },
            repositoryQueries: {
              items: expect.any(Object),
            },
          },
        });
        const context = { iteration: 1, toolCall: 1, toolUseId: "tool" };
        await inspectionTool.execute({
          objective: "Ground the requested source summary.",
          knowledgeQueries: [{
            query: "current attached repository snapshot",
            maxResults: 5,
          }],
          repositoryQueries: [],
        }, context);
        const serializedMessages = JSON.stringify(input.messages);
        expect(serializedMessages.length).toBeLessThan(8_000);
        expect(serializedMessages).not.toContain("src/path-0.ts");
        expect(serializedMessages).toContain("acme/robotics-controller");
        return modelResult([
          "| Source | Revision |",
          "|---|---|",
          "| Robotics controller | Current imported revision [citation:1] |",
        ].join("\n"), [
          "inspect_project",
        ]);
      }
      expect(input.tools).toEqual([]);
      expect(input.systemPrompt).toContain("No tools or new research are available");
      const serialized = JSON.stringify(input.messages);
      expect(serialized).toContain("frozenSources");
      expect(serialized).toContain("acme/robotics-controller");
      expect(serialized).not.toContain("src/path-0.ts");
      expect(serialized.length).toBeLessThan(45_000);
      return modelResult([
        "| Source | Revision |",
        "|---|---|",
        "| Robotics controller | Current imported revision [citation:1] |",
      ].join("\n"), []);
    });
  });

  it.each([
    "summarize the attached source in a table",
    "put the repository snapshot in a grid",
    "show the attached project source side by side with its revision",
  ])("repairs varied formatting without reopening tools: %s", async (question) => {
    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question,
      history: [{
        id: "assistant-1",
        role: "assistant",
        content: "Here is the earlier model matrix.",
        citations: [],
      }],
    })).resolves.toMatchObject({
      status: "answered",
      answer: expect.stringContaining("Robotics controller"),
      citationPolicy: "required_inline",
      fallbackUsed: false,
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Which two merged changes are newest, and how did their scope differ?",
    "Compare the latest pair of merged changes and justify the ordering.",
    "Show the most recent substantial merges side by side with their actual changes.",
  ])("uses one verifier-authorized evidence continuation for a central resolvable gap: %s", async (question) => {
    mocks.verify.mockReset()
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: false,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: "Establish the requested ordering, merge status, and changed scope from the attached repository.",
        recommendedCapabilities: ["repository_git"],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "The memory names changes, but I cannot establish their order.",
            centrality: "central",
            support: "ambiguous",
            action: "research",
            citationIndexes: [1],
            missingOrContradictedPremise: "The relative order and merge relationship are not established.",
            rationale: "Pinned Git history can resolve the central requested relationship.",
            confidence: "high",
          }],
        },
        issues: [{
          code: "central_relationship_unresolved",
          explanation: "Durable memory names changes but does not establish their order or merge status.",
          candidateCitationIndexes: [1],
        }],
        generationRunId: "verification-research-1",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: null,
        recommendedCapabilities: [],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "The pinned history establishes the newest and previous merges.",
            centrality: "central",
            support: "direct",
            action: "keep_direct",
            citationIndexes: [2],
            missingOrContradictedPremise: null,
            rationale: "The inspected merge log directly establishes the ordering.",
            confidence: "high",
          }],
        },
        issues: [],
        generationRunId: "verification-research-2",
        mechanicalIssues: [],
      });

    let attempt = 0;
    mocks.agentRun.mockImplementation(async (agentInput) => {
      attempt += 1;
      const inspection = agentInput.tools.find((tool: BedrockConverseTool) =>
        tool.name === "inspect_project"
      );
      expect(inspection).toBeDefined();
      if (attempt === 1) {
        const context = { iteration: 1, toolCall: 1, toolUseId: "knowledge" };
        await inspection.execute({
          objective: "Find substantial recent changes.",
          knowledgeQueries: [{ query: "substantial recent changes", maxResults: 5 }],
          repositoryQueries: [],
        }, context);
        return modelResult(
          "The memory names changes, but I cannot establish their order. [citation:1]",
          ["inspect_project"],
        );
      }
      expect(agentInput.tools.map((tool: BedrockConverseTool) => tool.name))
        .toEqual(["inspect_project"]);
      expect(agentInput.systemPrompt).toContain("one bounded evidence continuation");
      expect(JSON.stringify(agentInput.messages)).toContain(
        "Establish the requested ordering, merge status",
      );
      await inspection.execute({
        objective: "Establish the requested ordering and changed scope.",
        knowledgeQueries: [],
        repositoryQueries: [{
          sourceId: "source-1",
          args: ["log", "--merges", "--oneline", "-10"],
        }],
      }, { iteration: 1, toolCall: 1, toolUseId: "repository" });
      return modelResult([
        "| Order | Merge | Scope |",
        "|---|---|---|",
        "| Newest | `aaaa` | Current repository evidence establishes the newer merge. [citation:2] |",
        "| Previous | `bbbb` | The preceding merge is second in the pinned history. [citation:2] |",
      ].join("\n"), ["inspect_project"]);
    });

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question,
      history: [],
    })).resolves.toMatchObject({
      status: "answered",
      answer: expect.stringContaining("| Newest |"),
      citationPolicy: "required_inline",
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.inspectRepository).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        researchContinuationUsed: true,
        repaired: false,
      }),
    }));
  });

  it("projects a useful partial answer instead of globally refusing after a second criticism", async () => {
    mocks.verify.mockReset()
      .mockResolvedValueOnce(verificationFixture({
        action: "qualify",
        support: "reasonable_inference",
        explanation: "The implementation suggests this role, but does not define it exhaustively.",
      }))
      .mockResolvedValueOnce(verificationFixture({
        action: "remove_unfounded",
        support: "unfounded",
        quote: "The controller reduced latency by 40%.",
        explanation: "No source establishes the 40% metric.",
        citationIndexes: [],
      }))
      .mockResolvedValueOnce(verificationFixture({
        action: "keep_direct",
        support: "direct",
        explanation: "The final projection retains only the supported repository row.",
        generationRunId: "verification-projection",
      }));

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "Compare the controller components in a compact grid.",
      history: [],
    })).resolves.toMatchObject({
      status: "answered",
      publicationOutcome: "answered_with_gaps",
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(3);
    expect(mocks.verify).toHaveBeenCalledTimes(3);
    expect(mocks.agentRun.mock.calls[1]?.[0].tools).toEqual([]);
    expect(mocks.agentRun.mock.calls[2]?.[0].systemPrompt).toContain(
      "final publication projection",
    );
  });

  it("preserves verified model-role rows when peripheral role descriptions remain unsupported", async () => {
    mocks.verify.mockReset()
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: null,
        recommendedCapabilities: [],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "Primary answers use Terra and verification uses Luna.",
            centrality: "central",
            support: "direct",
            action: "keep_direct",
            citationIndexes: [1],
            missingOrContradictedPremise: null,
            rationale: "The inspected configuration directly maps both profiles.",
            confidence: "high",
          }, {
            id: "claim_2",
            quote: "Every Artifact is embedded.",
            centrality: "supporting",
            support: "unfounded",
            action: "remove_unfounded",
            citationIndexes: [1],
            missingOrContradictedPremise: "The source does not establish Artifact embedding coverage.",
            rationale: "The universal expands beyond the configured entity types.",
            confidence: "high",
          }],
        },
        issues: [],
        generationRunId: "verification-models-1",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: null,
        recommendedCapabilities: [],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "Primary answers use Terra and verification uses Luna.",
            centrality: "central",
            support: "direct",
            action: "keep_direct",
            citationIndexes: [1],
            missingOrContradictedPremise: null,
            rationale: "The current configuration directly maps both profiles.",
            confidence: "high",
          }, {
            id: "claim_2",
            quote: "Routing controls all research decisions.",
            centrality: "supporting",
            support: "unfounded",
            action: "remove_unfounded",
            citationIndexes: [1],
            missingOrContradictedPremise: "The profile assignment does not establish control of every research decision.",
            rationale: "The role description is broader than the source.",
            confidence: "high",
          }],
        },
        issues: [],
        generationRunId: "verification-models-2",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        requiresProjectCitations: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        answerUseful: true,
        researchObjective: null,
        recommendedCapabilities: [],
        claimLedger: {
          version: "project-chat-claim-ledger-v1",
          entries: [{
            id: "claim_1",
            quote: "Primary answers use Terra and verification uses Luna.",
            centrality: "central",
            support: "direct",
            action: "keep_direct",
            citationIndexes: [1],
            missingOrContradictedPremise: null,
            rationale: "The final matrix preserves the directly configured roles.",
            confidence: "high",
          }],
        },
        issues: [],
        generationRunId: "verification-models-3",
        mechanicalIssues: [],
      });

    let attempt = 0;
    mocks.agentRun.mockImplementation(async (agentInput) => {
      attempt += 1;
      if (attempt === 1) {
        const inspect = agentInput.tools.find((tool: BedrockConverseTool) =>
          tool.name === "inspect_project"
        )!;
        await inspect.execute({
          objective: "Inspect the current model-role configuration.",
          knowledgeQueries: [],
          repositoryQueries: [{
            sourceId: "source-1",
            args: ["show", "HEAD:src/lib/llm-config.ts"],
          }],
        }, { iteration: 1, toolCall: 1, toolUseId: "models" });
        return modelResult([
          "| Role | Model | Purpose |",
          "|---|---|---|",
          "| Primary answer | Terra | User-facing answers. [citation:1] |",
          "| Verification | Luna | Semantic verification. [citation:1] |",
          "| Embeddings | Titan | Every Artifact is embedded. [citation:1] |",
        ].join("\n"), ["inspect_project"]);
      }
      if (attempt === 2) {
        return modelResult([
          "| Role | Model | Purpose |",
          "|---|---|---|",
          "| Primary answer | Terra | User-facing answers. [citation:1] |",
          "| Verification | Luna | Semantic verification. [citation:1] |",
          "| Routing | Luna | Controls all research decisions. [citation:1] |",
        ].join("\n"), []);
      }
      expect(agentInput.systemPrompt).toContain("final publication projection");
      return modelResult([
        "| Role | Model | Purpose |",
        "|---|---|---|",
        "| Primary answer | Terra | User-facing answers. [citation:1] |",
        "| Verification | Luna | Semantic verification. [citation:1] |",
      ].join("\n"), []);
    });

    const result = await executeModelLedProjectChatAgent({
      runId: "run-model-matrix",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "What models are used for what?",
      history: [],
    });

    expect(result).toMatchObject({
      status: "answered",
      publicationOutcome: "answered_with_gaps",
      answer: expect.stringContaining("Primary answer"),
      claimAudit: {
        verificationHistory: expect.arrayContaining([
          expect.objectContaining({ attempt: 1 }),
          expect.objectContaining({ attempt: 2 }),
          expect.objectContaining({ attempt: 3 }),
        ]),
        ledger: { entries: expect.arrayContaining([
          expect.objectContaining({ action: "keep_direct" }),
        ]) },
      },
    });
    if (result.status === "answered") {
      expect(result.answer).toContain("Verification");
      expect(result.answer).not.toContain("Every Artifact");
      expect(result.answer).not.toContain("all research decisions");
    }
    expect(mocks.agentRun).toHaveBeenCalledTimes(3);
    expect(mocks.verify).toHaveBeenCalledTimes(3);
  });

  it("publishes a grounded useful revision with a transparent limitation", async () => {
    mocks.verify.mockReset()
      .mockResolvedValueOnce(verificationFixture({
        action: "qualify",
        support: "reasonable_inference",
        instructionSatisfied: false,
        explanation: "The source establishes scope but not an objective importance ranking.",
        generationRunId: "verification-ranking",
      }))
      .mockResolvedValueOnce(verificationFixture({
        action: "keep_inference",
        support: "reasonable_inference",
        explanation: "The answer now explicitly describes scope as its ranking basis.",
        generationRunId: "verification-qualified",
      }));

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "Which recent change was most substantial? Qualify how you judged that.",
      history: [],
    })).resolves.toMatchObject({
      status: "answered",
      answer: expect.stringContaining("Robotics controller"),
      citationPolicy: "required_inline",
      publicationOutcome: "answered_with_gaps",
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        publicationMode: "answered_with_gaps",
        repaired: true,
      }),
    }));
  });

  it("removes only an unfounded claim after the bounded revision", async () => {
    mocks.verify.mockReset();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      mocks.verify.mockResolvedValueOnce(verificationFixture({
        action: "remove_unfounded",
        support: "unfounded",
        quote: "The controller reduced latency by 40%.",
        explanation: `No source establishes the metric after verification ${attempt}.`,
        generationRunId: `verification-${attempt}`,
        citationIndexes: [],
      }));
    }
    mocks.verify.mockResolvedValueOnce(verificationFixture({
      action: "keep_direct",
      support: "direct",
      explanation: "The final projection contains only the supported repository row.",
      generationRunId: "verification-3",
    }));

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "Map the supported project components.",
      history: [],
    })).resolves.toMatchObject({
      status: "answered",
      publicationOutcome: "answered_with_gaps",
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(3);
    expect(mocks.verify).toHaveBeenCalledTimes(3);
  });

  it("returns a cited frozen-source boundary when the tool-free repair cannot complete", async () => {
    const initialImplementation = mocks.agentRun.getMockImplementation();
    if (!initialImplementation) {
      throw new Error("Expected the initial model implementation");
    }
    mocks.agentRun
      .mockImplementationOnce(initialImplementation)
      .mockRejectedValueOnce(new Error("repair token budget exhausted"));

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "summarize the attached source in a table",
      history: [],
    })).resolves.toMatchObject({
      status: "answered",
      answer: expect.stringContaining("Robotics controller"),
      publicationOutcome: "answered_with_gaps",
      fallbackUsed: true,
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ mode: "frozen_repair_failed" }),
    }));
  });

  it("publishes the mechanically grounded answer when semantic verification cannot complete", async () => {
    mocks.verify.mockReset().mockRejectedValueOnce(
      new Error("semantic verifier exhausted its structured retries"),
    );

    const result = await executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "summarize the attached source in a table",
      history: [],
    });
    expect(result).toMatchObject({
      status: "answered",
      answer: expect.stringContaining("Robotics controller"),
      publicationOutcome: "answered_with_gaps",
      fallbackUsed: true,
      claimAudit: {
        verificationHistory: [],
        ledger: {
          entries: expect.arrayContaining([
            expect.objectContaining({
              support: "ambiguous",
              action: "qualify",
            }),
          ]),
        },
      },
      research: {
        warnings: expect.arrayContaining([
          expect.stringContaining("Semantic claim verification did not complete"),
        ]),
      },
    });
    if (result.status === "answered") {
      expect(result.answer).toContain("portion I could support directly");
      expect(result.answer).not.toContain("Semantic verification did not complete");
    }
    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ mode: "semantic_verification_failed" }),
    }));
  });

  it.each([
    {
      question: "New commits landed; update the reusable project picture before answering.",
      toolName: "refresh_project_knowledge",
      toolInput: { reason: "The user requested a durable update." },
      expected: {
        status: "refresh_requested",
        reason: "The user requested a durable update.",
      },
    },
    {
      question: "Turn the supported robotics work into a short case study.",
      toolName: "create_project_artifact",
      toolInput: { brief: "A short robotics-controller case study." },
      expected: {
        status: "artifact_requested",
        brief: "A short robotics-controller case study.",
      },
    },
  ])("honors the primary model's $toolName control decision", async ({
    question,
    toolName,
    toolInput,
    expected,
  }) => {
    mocks.verify.mockReset();
    mocks.agentRun.mockImplementationOnce(async (input) => {
      const selected = input.tools.find((tool: BedrockConverseTool) =>
        tool.name === toolName
      );
      expect(selected).toBeDefined();
      if (!selected) throw new Error(`Missing tool ${toolName}`);
      await selected.execute(toolInput, {
        iteration: 1,
        toolCall: 1,
        toolUseId: "control-tool",
      });
      return modelResult("", [toolName]);
    });

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question,
      history: [],
    })).resolves.toMatchObject(expected);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
  });
});
