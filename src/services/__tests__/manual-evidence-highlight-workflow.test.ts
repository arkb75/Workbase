import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ workflowRunId: "workflow-owner" }));
const prismaMock = vi.hoisted(() => ({
  agentRun: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const readinessMock = vi.hoisted(() => vi.fn());
const prepareMock = vi.hoisted(() => vi.fn());
const persistMock = vi.hoisted(() => vi.fn());
const finalizeMock = vi.hoisted(() => vi.fn());
const markRunningMock = vi.hoisted(() => vi.fn());
const appendEventMock = vi.hoisted(() => vi.fn());
const failRunMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("workflow", () => ({
  FatalError: class FatalError extends Error {},
  getWorkflowMetadata: () => ({ workflowRunId: state.workflowRunId }),
  sleep: sleepMock,
}));
vi.mock("@/src/services/runtime-readiness-service", () => ({
  runtimeReadinessService: { check: readinessMock },
}));
vi.mock("@/src/services/manual-evidence-highlight-service", () => ({
  MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND: "manual_evidence_highlights",
  prepareManualEvidenceHighlights: prepareMock,
  persistManualEvidenceHighlights: persistMock,
  finalizeManualEvidenceHighlights: finalizeMock,
}));
vi.mock("@/src/services/project-chat-store", () => ({
  markAgentRunRunning: markRunningMock,
  appendAgentRunEvent: appendEventMock,
  failAgentRun: failRunMock,
}));

import {
  claimManualEvidenceHighlightWorkflowOwnership,
  manualEvidenceHighlightWorkflow,
} from "@/workflows/manual-evidence-highlights";

const plan = {
  inputFingerprint: "fingerprint-1",
  drafts: [],
  generationRunIds: [],
};

describe("manual Evidence Highlight workflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.workflowRunId = "workflow-owner";
    readinessMock.mockResolvedValue({ ready: true });
    markRunningMock.mockResolvedValue({ active: true, status: "running" });
    appendEventMock.mockResolvedValue(null);
    prepareMock.mockResolvedValue({ status: "prepared", plan });
    persistMock.mockResolvedValue({
      status: "persisted",
      terminalOutcome: "no_safe_candidates",
      createdHighlightIds: [],
      replayedHighlightIds: [],
      deduplicatedHighlightIds: [],
      suggestionIds: [],
      suppressedHighlightIds: [],
    });
    finalizeMock.mockResolvedValue({ persisted: true, status: "completed" });
    sleepMock.mockResolvedValue(undefined);
  });

  it("self-attaches its exact Workflow ID before readiness or provider work", async () => {
    prismaMock.agentRun.findUnique.mockResolvedValueOnce({
      workflowId: "starting:123:reservation",
      status: "queued",
      kind: "manual_evidence_highlights",
    });
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(manualEvidenceHighlightWorkflow("run-1")).resolves.toMatchObject({
      status: "completed",
      terminalOutcome: "no_safe_candidates",
    });

    expect(prismaMock.agentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        kind: "manual_evidence_highlights",
        workflowId: "starting:123:reservation",
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: { workflowId: "workflow-owner" },
    });
    expect(prismaMock.agentRun.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      readinessMock.mock.invocationCallOrder[0]!,
    );
    expect(readinessMock.mock.invocationCallOrder[0]).toBeLessThan(
      prepareMock.mock.invocationCallOrder[0]!,
    );
  });

  it("does no readiness or provider work when another exact Workflow owns the run", async () => {
    prismaMock.agentRun.findUnique.mockResolvedValueOnce({
      workflowId: "workflow-winner",
      status: "running",
      kind: "manual_evidence_highlights",
    });

    await expect(manualEvidenceHighlightWorkflow("run-1")).resolves.toEqual({
      status: "superseded",
      replayed: true,
      attachedWorkflowId: "workflow-winner",
    });
    expect(readinessMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("exits before model work when deletion terminalized the AgentRun", async () => {
    prismaMock.agentRun.findUnique.mockResolvedValueOnce({
      workflowId: "workflow-owner",
      status: "cancelled",
      kind: "manual_evidence_highlights",
    });

    await expect(manualEvidenceHighlightWorkflow("run-deleted")).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });
    expect(readinessMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("records superseded_input as a completed terminal outcome", async () => {
    prismaMock.agentRun.findUnique.mockResolvedValueOnce({
      workflowId: "workflow-owner",
      status: "queued",
      kind: "manual_evidence_highlights",
    });
    prepareMock.mockResolvedValueOnce({
      status: "superseded_input",
      inputFingerprint: "fingerprint-old",
    });

    await expect(manualEvidenceHighlightWorkflow("run-old")).resolves.toEqual({
      status: "completed",
      terminalOutcome: "superseded_input",
    });
    expect(persistMock).not.toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith({
      runId: "run-old",
      plan: null,
      result: {
        status: "superseded_input",
        terminalOutcome: "superseded_input",
        createdHighlightIds: [],
        replayedHighlightIds: [],
        deduplicatedHighlightIds: [],
        suggestionIds: [],
        suppressedHighlightIds: [],
      },
    });
  });

  it("durably waits for repository reconciliation and then applies the same prepared plan", async () => {
    prismaMock.agentRun.findUnique.mockResolvedValueOnce({
      workflowId: "workflow-owner",
      status: "queued",
      kind: "manual_evidence_highlights",
    });
    persistMock
      .mockResolvedValueOnce({ status: "deferred_repository_refresh" })
      .mockResolvedValueOnce({
        status: "persisted",
        terminalOutcome: "ready",
        createdHighlightIds: ["highlight-1"],
        replayedHighlightIds: [],
        deduplicatedHighlightIds: [],
        suggestionIds: [],
        suppressedHighlightIds: [],
      });

    await expect(manualEvidenceHighlightWorkflow("run-1")).resolves.toMatchObject({
      status: "completed",
      terminalOutcome: "ready",
      createdHighlightIds: ["highlight-1"],
    });
    expect(sleepMock).toHaveBeenCalledWith("5s");
    expect(persistMock).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenNthCalledWith(1, { runId: "run-1", plan });
    expect(persistMock).toHaveBeenNthCalledWith(2, { runId: "run-1", plan });
  });

  it("resolves a lost ownership CAS from the authoritative winner", async () => {
    prismaMock.agentRun.findUnique
      .mockResolvedValueOnce({
        workflowId: "starting:123:reservation",
        status: "queued",
        kind: "manual_evidence_highlights",
      })
      .mockResolvedValueOnce({
        workflowId: "workflow-winner",
        status: "running",
        kind: "manual_evidence_highlights",
      });
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimManualEvidenceHighlightWorkflowOwnership(
      "run-race",
      "workflow-orphan",
    )).resolves.toEqual({
      status: "superseded",
      attachedWorkflowId: "workflow-winner",
    });
  });
});
