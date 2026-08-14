import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BedrockConverseAgentEvent,
  TextConverseTool,
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
        output: "aaaa newest merge\nbbbb prior merge",
        outputHash: "f".repeat(64),
        truncated: false,
      }],
      usage: { queries: 1, visibleBytes: 35 },
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
          version: "project-chat-model-checkpoint-v9",
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
        verdict: "repair",
        requiresProjectCitations: true,
        groundingSatisfied: false,
        instructionSatisfied: true,
        formatSatisfied: true,
        researchObjective: null,
        recommendedCapabilities: [],
        issues: [{
          code: "uncited_project_claim",
          explanation: "Attach the source citation to the repository row.",
          candidateCitationIndexes: [1],
        }],
        generationRunId: "verification-1",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        verdict: "publish",
        requiresProjectCitations: true,
        groundingSatisfied: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        researchObjective: null,
        recommendedCapabilities: [],
        issues: [],
        generationRunId: "verification-2",
        mechanicalIssues: [],
      });
    let modelAttempt = 0;
    mocks.agentRun.mockImplementation(async (input) => {
      modelAttempt += 1;
      if (modelAttempt === 1) {
        const inspectionTool = input.tools.find((tool: TextConverseTool) =>
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
        verdict: "continue_research",
        requiresProjectCitations: true,
        groundingSatisfied: true,
        instructionSatisfied: false,
        formatSatisfied: true,
        researchObjective: "Establish the requested ordering, merge status, and changed scope from the attached repository.",
        recommendedCapabilities: ["repository_git"],
        issues: [{
          code: "central_relationship_unresolved",
          explanation: "Durable memory names changes but does not establish their order or merge status.",
          candidateCitationIndexes: [1],
        }],
        generationRunId: "verification-research-1",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        verdict: "publish",
        requiresProjectCitations: true,
        groundingSatisfied: true,
        instructionSatisfied: true,
        formatSatisfied: true,
        researchObjective: null,
        recommendedCapabilities: [],
        issues: [],
        generationRunId: "verification-research-2",
        mechanicalIssues: [],
      });

    let attempt = 0;
    mocks.agentRun.mockImplementation(async (agentInput) => {
      attempt += 1;
      const inspection = agentInput.tools.find((tool: TextConverseTool) =>
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
      expect(agentInput.tools.map((tool: TextConverseTool) => tool.name))
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

  it("does not loop through a second semantic repair", async () => {
    const repairVerdict = (explanation: string) => ({
      verdict: "repair" as const,
      requiresProjectCitations: true,
      groundingSatisfied: false,
      instructionSatisfied: true,
      formatSatisfied: true,
      researchObjective: null,
      recommendedCapabilities: [],
      issues: [{ code: "unsupported_claim", explanation, candidateCitationIndexes: [] }],
      generationRunId: `verification-${explanation.length}`,
      mechanicalIssues: [],
    });
    mocks.verify.mockReset()
      .mockResolvedValueOnce(repairVerdict("Remove the unsupported path."))
      .mockResolvedValueOnce(repairVerdict("Remove the remaining unsupported qualifier."));

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "Compare the controller components in a compact grid.",
      history: [],
    })).resolves.toMatchObject({
      status: "insufficient_context",
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.agentRun.mock.calls[1]?.[0].tools).toEqual([]);
  });

  it("publishes a grounded useful revision with a transparent limitation", async () => {
    mocks.verify.mockReset()
      .mockResolvedValueOnce({
        verdict: "repair",
        requiresProjectCitations: true,
        groundingSatisfied: false,
        instructionSatisfied: false,
        formatSatisfied: true,
        researchObjective: null,
        recommendedCapabilities: [],
        issues: [{
          code: "unsupported_ranking",
          explanation: "The source establishes the changes but not an objective importance ranking.",
          candidateCitationIndexes: [1],
        }],
        generationRunId: "verification-ranking",
        mechanicalIssues: [],
      })
      .mockResolvedValueOnce({
        verdict: "publish_with_limitations",
        requiresProjectCitations: true,
        groundingSatisfied: true,
        instructionSatisfied: false,
        formatSatisfied: true,
        researchObjective: null,
        recommendedCapabilities: [],
        issues: [{
          code: "qualified_ranking",
          explanation: "The answer explicitly describes scope as its ranking basis.",
          candidateCitationIndexes: [1],
        }],
        generationRunId: "verification-qualified",
        mechanicalIssues: [],
      });

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
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        publicationMode: "publish_with_limitations",
        repaired: true,
      }),
    }));
  });

  it("fails closed after both frozen-source revisions remain unsupported", async () => {
    mocks.verify.mockReset();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      mocks.verify.mockResolvedValueOnce({
        verdict: "repair",
        requiresProjectCitations: true,
        groundingSatisfied: false,
        instructionSatisfied: true,
        formatSatisfied: true,
        researchObjective: null,
        recommendedCapabilities: [],
        issues: [{
          code: "unsupported_claim",
          explanation: `Unsupported claim remains after verification ${attempt}.`,
          candidateCitationIndexes: [],
        }],
        generationRunId: `verification-${attempt}`,
        mechanicalIssues: [],
      });
    }

    await expect(executeModelLedProjectChatAgent({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "Map the supported project components.",
      history: [],
    })).resolves.toMatchObject({
      status: "insufficient_context",
      fallbackUsed: false,
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
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
      status: "insufficient_context",
      answer: expect.stringContaining("couldn’t verify enough project evidence"),
      citationPolicy: "required_inline",
      fallbackUsed: false,
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ mode: "frozen_repair_failed" }),
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
      const selected = input.tools.find((tool: TextConverseTool) =>
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
