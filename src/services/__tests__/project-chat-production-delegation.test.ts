import { describe, expect, it, vi } from "vitest";

const executeModelLedMock = vi.hoisted(() => vi.fn(async () => ({
  status: "answered" as const,
  answer: "Model-authored answer",
  citations: [],
  citationPolicy: "none" as const,
  groundedClaims: [],
  freshness: null,
  research: {
    status: "answered" as const,
    answer: "Model-authored answer",
    findings: [],
    citations: [],
    coverageGaps: [],
    warnings: [],
    candidateIds: [],
    generationRunIds: ["primary-answer-run"],
    partial: false,
    exploredEvidence: [],
    coverage: null,
  },
  fallbackUsed: false,
})));

vi.mock("@/src/lib/llm-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/llm-config")>()),
  resolveWorkbaseLlmProvider: () => "openrouter",
}));

vi.mock("@/src/services/project-chat-model-agent-service", () => ({
  executeModelLedProjectChatAgent: executeModelLedMock,
}));

import {
  finalizeProjectChatAfterFactReview,
  runProjectChatAgent,
  usesLegacyProjectChatTestHarness,
} from "@/src/services/project-chat-agent-service";

const input = {
  runId: "run-1",
  userId: "user-1",
  workItemId: "work-1",
  threadId: "thread-1",
  messageId: "message-1",
  question: "Give me a matrix of the active models and their purposes.",
};

describe("production project-chat delegation", () => {
  it("confines the legacy deterministic agent to the mock test harness", () => {
    expect(usesLegacyProjectChatTestHarness({
      provider: "mock",
      nodeEnv: "test",
      vitest: "true",
    })).toBe(true);
    expect(usesLegacyProjectChatTestHarness({
      provider: "mock",
      nodeEnv: "production",
      vitest: undefined,
    })).toBe(false);
    expect(usesLegacyProjectChatTestHarness({
      provider: "openrouter",
      nodeEnv: "test",
      vitest: "true",
    })).toBe(false);
  });

  it("routes every non-mock turn to the model-led agent", async () => {
    await expect(runProjectChatAgent(input)).resolves.toMatchObject({
      answer: "Model-authored answer",
      fallbackUsed: false,
    });
    expect(executeModelLedMock).toHaveBeenCalledWith(input);
  });

  it("resumes reviewed facts through the same model-led agent with research disabled", async () => {
    await finalizeProjectChatAfterFactReview(input);
    expect(executeModelLedMock).toHaveBeenCalledWith({
      ...input,
      allowResearch: false,
      afterFactReview: true,
    });
  });
});
