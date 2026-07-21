import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "workflow/errors";

const mocks = vi.hoisted(() => ({
  findCandidate: vi.fn(),
  countCandidates: vi.fn(),
  findRun: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  resumeHook: mocks.resumeHook,
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    agentRunCandidate: {
      findFirstOrThrow: mocks.findCandidate,
      count: mocks.countCandidates,
    },
    agentRun: {
      findUnique: mocks.findRun,
    },
  },
}));

vi.mock("@/src/services/highlight-suggestion-service", () => ({
  coerceStoredHighlightDraft: vi.fn(),
  refreshHighlightEmbeddingFromDraft: vi.fn(),
}));
vi.mock("@/src/services/knowledge-embedding-service", () => ({
  buildProjectFactEmbeddingText: vi.fn(),
  upsertProjectFactEmbedding: vi.fn(),
}));
vi.mock("@/src/lib/evidence-persistence", () => ({
  createHighlightWithRelations: vi.fn(),
}));

import { resolveAgentCandidate } from "@/src/services/candidate-review-service";

function resolvedCandidate() {
  return {
    id: "candidate-1",
    agentRunId: "run-1",
    batchNumber: 1,
    status: "approved",
    kind: "new_project_fact",
    highlight: null,
    highlightSuggestion: null,
    projectFact: null,
    agentRun: { id: "run-1" },
  };
}

function reviewInput() {
  return {
    userId: "user-1",
    candidateId: "candidate-1",
    decision: "approve" as const,
    idempotencyKey: "review:candidate-1:approve",
  };
}

describe("candidate review workflow resumption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCandidate.mockResolvedValue(resolvedCandidate());
    mocks.countCandidates.mockResolvedValue(0);
    mocks.findRun.mockResolvedValue({ status: "awaiting_review" });
  });

  it("retries a saved decision after a transient resume failure", async () => {
    mocks.resumeHook.mockRejectedValueOnce(new Error("workflow provider unavailable"));

    await expect(resolveAgentCandidate(reviewInput())).rejects.toThrow(
      "workflow provider unavailable",
    );

    mocks.resumeHook.mockResolvedValueOnce({ runId: "workflow-run-1" });
    await expect(resolveAgentCandidate(reviewInput())).resolves.toMatchObject({
      candidateId: "candidate-1",
      status: "approved",
      resumedRunId: "workflow-run-1",
    });
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
  });

  it("retries HookNotFoundError while the workflow registers its review hook", async () => {
    mocks.resumeHook
      .mockRejectedValueOnce(new HookNotFoundError("agent-run:run-1:review:1"))
      .mockResolvedValueOnce({ runId: "workflow-run-1" });

    await expect(resolveAgentCandidate(reviewInput())).resolves.toMatchObject({
      resumedRunId: "workflow-run-1",
    });
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
  });

  it("treats a batch that already moved forward as idempotently resumed", async () => {
    mocks.findRun.mockResolvedValue({ status: "running" });

    await expect(resolveAgentCandidate(reviewInput())).resolves.toMatchObject({
      candidateId: "candidate-1",
      status: "approved",
      resumedRunId: null,
    });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });
});
