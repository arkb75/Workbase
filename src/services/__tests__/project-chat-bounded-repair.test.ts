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
  resolveEmbedding: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    agentRun: { findFirstOrThrow: mocks.agentRunFind },
  },
}));

vi.mock("@/src/services/project-chat-turn-planner-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/project-chat-turn-planner-service")>()),
  ensureProjectChatTurnPlan: vi.fn(async () => ({
    version: "project-chat-turn-plan-v1",
    objective: "Refresh the repository and update the previous runtime matrix.",
    action: "refresh_then_answer",
    allowRepositoryResearch: false,
    knowledgeQueries: ["runtime model configuration"],
    outputFormat: "Updated matrix",
    outputRequirements: ["Report what changed."],
    reasonCodes: ["new_push"],
    confidence: 0.95,
    generationRunId: "plan-generation",
  })),
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

vi.mock("@/src/services/embedding-index-service", () => ({
  resolveActiveEmbeddingIndex: mocks.resolveEmbedding,
}));

vi.mock("@/src/services/project-chat-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/project-chat-store")>()),
  appendAgentRunEvent: mocks.appendEvent,
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
    repository: "arkb75/Workbase",
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
    mocks.resolveEmbedding.mockResolvedValue({
      id: "embedding-1",
      key: "bedrock-titan-512",
      provider: "bedrock",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 512,
      status: "active",
      writeEnabled: true,
    });
    mocks.agentRunFind.mockResolvedValue({
      workItem: {
        title: "Workbase",
        type: "project",
        description: "",
        sources: [{
          id: "source-1",
          label: "arkb75/Workbase",
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
          repository: "arkb75/Workbase",
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
          version: "project-chat-model-checkpoint-v4",
          answer: executed.result.text,
          catalog: executed.checkpoint.catalog,
          entries: executed.checkpoint.entries,
          research: executed.checkpoint.research,
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
        issues: [{
          code: "uncited_project_claim",
          explanation: "Attach the runtime citation directly to the embedding row.",
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
        issues: [],
        generationRunId: "verification-2",
        mechanicalIssues: [],
      });
    let modelAttempt = 0;
    mocks.agentRun.mockImplementation(async (input) => {
      modelAttempt += 1;
      if (modelAttempt === 1) {
        const repositoryTool = input.tools.find((tool: TextConverseTool) =>
          tool.name === "inspect_repository_state"
        );
        const runtimeTool = input.tools.find((tool: TextConverseTool) =>
          tool.name === "inspect_runtime_model_profiles"
        );
        const context = { iteration: 1, toolCall: 1, toolUseId: "tool" };
        const repositoryResult = await repositoryTool.execute({}, context);
        const runtimeResult = await runtimeTool.execute({}, context);
        expect(JSON.stringify(repositoryResult).length).toBeLessThan(3_000);
        expect(JSON.stringify(repositoryResult)).not.toContain("src/path-0.ts");
        expect(JSON.stringify(runtimeResult)).toContain("amazon.titan-embed-text-v2:0");
        return modelResult([
          "| Purpose | Model |",
          "|---|---|",
          "| Text | Sonnet [citation:2] |",
          "| Embeddings | Titan 512 |",
          "",
          "The refreshed repository has complete coverage. [citation:1]",
        ].join("\n"), [
          "inspect_repository_state",
          "inspect_runtime_model_profiles",
        ]);
      }
      expect(input.tools).toEqual([]);
      expect(input.systemPrompt).toContain("No tools or new research are available");
      const serialized = JSON.stringify(input.messages);
      expect(serialized).toContain("frozenSources");
      expect(serialized).toContain("amazon.titan-embed-text-v2:0");
      expect(serialized).not.toContain("src/path-0.ts");
      expect(serialized.length).toBeLessThan(45_000);
      return modelResult([
        "| Purpose | Model |",
        "|---|---|",
        "| Text | Sonnet [citation:2] |",
        "| Embeddings | Titan, 512 dimensions [citation:2] |",
        "",
        "The refreshed repository has complete coverage. [citation:1]",
      ].join("\n"), []);
    });
  });

  it.each([
    "i pushed some stuff",
    "I just pushed a few changes—update that",
    "There are new commits now; make the previous matrix current",
  ])("repairs a refreshed large-repository answer without reopening tools: %s", async (question) => {
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
      answer: expect.stringContaining("Titan, 512 dimensions"),
      citationPolicy: "required_inline",
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
      question: "i pushed some stuff",
      history: [],
    })).resolves.toMatchObject({
      status: "insufficient_context",
      answer: expect.stringContaining("frozen sources did not support every part"),
      citationPolicy: "required_inline",
      fallbackUsed: false,
    });
    expect(mocks.agentRun).toHaveBeenCalledTimes(2);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ mode: "frozen_repair_failed" }),
    }));
  });
});
