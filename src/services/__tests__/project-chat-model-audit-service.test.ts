import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedrockConverseLimitError,
  type BedrockConverseAgentRunResult,
} from "@/src/lib/bedrock-converse-agent";

const mocks = vi.hoisted(() => ({
  findReplay: vi.fn(),
  createIdempotently: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/src/lib/generation-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/generation-runs")>()),
  findSuccessfulGenerationRunReplay: mocks.findReplay,
  createGenerationRunIdempotently: mocks.createIdempotently,
  createGenerationRun: mocks.create,
  generationRunFailureTokenUsage: vi.fn(() => ({
    providerAttemptCount: 1,
    failedAttempts: [{ requestId: "failed-request" }],
  })),
}));

vi.mock("@/src/lib/llm-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/llm-config")>()),
  resolveActiveTextModelIdentity: () => ({
    provider: "openrouter",
    modelId: "configured-primary-model",
    profile: "primary_answer",
  }),
}));

import {
  PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
  runAuditedProjectChatModel,
} from "@/src/services/project-chat-model-audit-service";

const result: BedrockConverseAgentRunResult = {
  text: "The model-authored answer.",
  assistantMessage: {
    role: "assistant",
    content: [{ text: "The model-authored answer." }],
  },
  messages: [],
  stopReason: "end_turn",
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    unknownUsageAttempts: 0,
  },
  events: [
    {
      type: "model_call_completed",
      iteration: 1,
      stopReason: "tool_use",
      requestId: "request-1",
      durationMs: 100,
      usage: {
        inputTokens: 70,
        outputTokens: 10,
        totalTokens: 80,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      aggregateUsage: {
        inputTokens: 70,
        outputTokens: 10,
        totalTokens: 80,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      provider: "openrouter",
      routedProvider: "openai",
      modelId: "actual-primary-model",
      costUsd: 0.01,
      profile: "primary_answer",
    },
    {
      type: "tool_call_completed",
      iteration: 1,
      toolCall: 1,
      toolUseId: "tool-1",
      toolName: "inspect_project",
      outcome: "success",
      durationMs: 2,
      output: { citationIndex: 1 },
    },
  ],
  iterations: 2,
  toolCalls: 1,
  requestIds: ["request-1"],
  routedProviders: ["openai"],
  provider: "openrouter",
  modelId: "actual-primary-model",
  reportedCostUsd: 0.01,
};

describe("project-chat primary-model audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findReplay.mockResolvedValue(null);
    mocks.createIdempotently.mockResolvedValue({ id: "generation-1" });
    mocks.create.mockResolvedValue({ id: "generation-failed" });
  });

  it("persists authoritative primary-answer identity, tools, usage, cost, and replay state", async () => {
    const executed = vi.fn(async () => ({
      result,
      checkpoint: {
        catalog: [],
        entries: [],
        research: null,
        control: {
          refreshRequested: false,
          refreshReason: null,
          artifactBrief: null,
        },
      },
    }));
    const audited = await runAuditedProjectChatModel({
      workItemId: "work-1",
      agentRunId: "agent-1",
      phase: "initial",
      attempt: "initial",
      inputSummary: { objective: "runtime mapping" },
      execute: executed,
    });

    expect(audited).toMatchObject({ generationRunId: "generation-1", replayed: false });
    expect(audited.checkpoint).toMatchObject({
      version: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
      answer: "The model-authored answer.",
      toolNames: ["inspect_project"],
    });
    expect(mocks.createIdempotently).toHaveBeenCalledWith(expect.objectContaining({
      kind: "project_chat_answer",
      status: "success",
      provider: "openrouter",
      modelId: "actual-primary-model",
      estimatedCostUsd: 0.01,
      resultRefs: expect.objectContaining({
        profile: "primary_answer",
        configuredModelId: "configured-primary-model",
        requestIds: ["request-1"],
        toolNames: ["inspect_project"],
        auditEvidenceTruncated: false,
      }),
      tokenUsage: expect.objectContaining({
        providerAttemptCount: 1,
        unknownUsageAttempts: 0,
      }),
    }));
  });

  it("replays a successful durable checkpoint without another provider call", async () => {
    mocks.findReplay.mockResolvedValue({
      id: "existing-generation",
      parsedOutput: {
        version: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
        answer: "Previously completed answer",
        catalog: [],
        entries: [],
        research: null,
        toolNames: ["inspect_project"],
        control: {
          refreshRequested: false,
          refreshReason: null,
          artifactBrief: null,
        },
      },
    });
    const execute = vi.fn();
    await expect(runAuditedProjectChatModel({
      workItemId: "work-1",
      agentRunId: "agent-1",
      phase: "initial",
      attempt: "initial",
      inputSummary: {},
      execute,
    })).resolves.toMatchObject({
      generationRunId: "existing-generation",
      replayed: true,
      checkpoint: { answer: "Previously completed answer" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.createIdempotently).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed durable checkpoint instead of trusting cast JSON", async () => {
    mocks.findReplay.mockResolvedValue({
      id: "corrupt-generation",
      parsedOutput: {
        version: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
        answer: "Unsupported replay",
        catalog: [{ kind: "evidence", label: "missing excerpt" }],
        entries: [],
        research: null,
        toolNames: [],
        control: {
          refreshRequested: false,
          refreshReason: null,
          artifactBrief: null,
        },
      },
    });
    await expect(runAuditedProjectChatModel({
      workItemId: "work-1",
      agentRunId: "agent-1",
      phase: "initial",
      attempt: "initial",
      inputSummary: {},
      execute: vi.fn(),
    })).rejects.toThrow("checkpoint is malformed");
  });

  it("records a provider failure and never substitutes deterministic prose", async () => {
    const error = Object.assign(new Error("provider unavailable"), {
      name: "TimeoutError",
    });
    await expect(runAuditedProjectChatModel({
      workItemId: "work-1",
      agentRunId: "agent-1",
      phase: "initial",
      attempt: "initial",
      inputSummary: {},
      execute: async () => { throw error; },
    })).rejects.toBe(error);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "project_chat_answer",
      status: "provider_error",
      provider: "openrouter",
      modelId: "configured-primary-model",
      validationErrors: expect.objectContaining({ name: "TimeoutError" }),
    }));
    expect(mocks.createIdempotently).not.toHaveBeenCalled();
  });

  it("preserves completed provider attempts when a bounded research run reaches its host limit", async () => {
    const error = new BedrockConverseLimitError(
      "research budget reached",
      "iteration_limit_exceeded",
      7,
      8,
      {
        iterations: 7,
        toolCalls: 6,
        usage: result.usage,
        events: result.events,
        requestIds: ["request-1"],
        routedProviders: ["openai"],
        reportedCostUsd: 0.01,
      },
    );
    await expect(runAuditedProjectChatModel({
      workItemId: "work-1",
      agentRunId: "agent-1",
      phase: "initial",
      attempt: "initial",
      inputSummary: {},
      execute: async () => { throw error; },
    })).rejects.toBe(error);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      status: "provider_error",
      estimatedCostUsd: 0.01,
      resultRefs: expect.objectContaining({
        requestIds: ["request-1"],
        routedProviders: ["openai"],
        iterations: 7,
        toolCallCount: 6,
      }),
      tokenUsage: expect.objectContaining({
        providerAttemptCount: 1,
        attempts: [expect.objectContaining({ requestId: "request-1" })],
      }),
    }));
  });
});
