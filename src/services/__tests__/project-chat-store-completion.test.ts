import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRun: vi.fn(),
  findAssistant: vi.fn(),
  deleteCitations: vi.fn(),
  createCitations: vi.fn(),
  updateMessage: vi.fn(),
  findOlderMessages: vi.fn(),
  updateThread: vi.fn(),
  updateRun: vi.fn(),
  updateArtifacts: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (
      callback: (tx: {
        $queryRaw: typeof mocks.queryRun;
        chatMessage: {
          findFirstOrThrow: typeof mocks.findAssistant;
          update: typeof mocks.updateMessage;
          findMany: typeof mocks.findOlderMessages;
        };
        chatCitation: {
          deleteMany: typeof mocks.deleteCitations;
          createMany: typeof mocks.createCitations;
        };
        chatThread: { update: typeof mocks.updateThread };
        agentRun: { update: typeof mocks.updateRun };
        artifact: { updateMany: typeof mocks.updateArtifacts };
      }) => Promise<unknown>,
    ) => callback({
      $queryRaw: mocks.queryRun,
      chatMessage: {
        findFirstOrThrow: mocks.findAssistant,
        update: mocks.updateMessage,
        findMany: mocks.findOlderMessages,
      },
      chatCitation: {
        deleteMany: mocks.deleteCitations,
        createMany: mocks.createCitations,
      },
      chatThread: { update: mocks.updateThread },
      agentRun: { update: mocks.updateRun },
      artifact: { updateMany: mocks.updateArtifacts },
    })),
  },
}));

import { completeAgentRun } from "@/src/services/project-chat-store";

const runningRun = {
  status: "running",
  result: null,
  researchState: null,
  environmentSnapshot: null,
  workItemId: "work-item-1",
};

function mockArtifactProvenance(input?: {
  highlight?: Partial<{
    verificationStatus: string;
    lifecycleStatus: string;
    publicSafetyStatus: string;
    sensitivityFlag: boolean;
    visibility: string;
  }>;
  evidence?: Partial<{
    included: boolean;
    lifecycleStatus: string;
  }>;
  linked?: boolean;
}) {
  mocks.queryRun
    .mockResolvedValueOnce([runningRun])
    .mockResolvedValueOnce([{
      id: "artifact-new",
      type: "project_summary",
      lifecycleStatus: "quarantined",
      publicSafetyStatus: "verified",
      workItemId: "work-item-1",
      originatingAgentRunId: "run-artifact",
    }])
    .mockResolvedValueOnce([{ id: "artifact-highlight-1", highlightId: "highlight-1" }])
    .mockResolvedValueOnce([{ id: "artifact-evidence-1", evidenceItemId: "evidence-1" }])
    .mockResolvedValueOnce([{
      id: "highlight-1",
      verificationStatus: "approved",
      lifecycleStatus: "active",
      publicSafetyStatus: "verified",
      sensitivityFlag: false,
      visibility: "public_safe",
      ...input?.highlight,
    }])
    .mockResolvedValueOnce([{
      id: "evidence-1",
      included: true,
      lifecycleStatus: "active",
      ...input?.evidence,
    }])
    .mockResolvedValueOnce(input?.linked === false
      ? []
      : [{
          highlightId: "highlight-1",
          evidenceItemId: "evidence-1",
        }]);
}

describe("project chat completion citation replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Some provenance failures return before consuming the remaining queued
    // raw-query fixtures, so reset the implementation as well as call state.
    mocks.queryRun.mockReset();
    mocks.queryRun.mockResolvedValue([runningRun]);
    mocks.findAssistant.mockResolvedValue({
      id: "assistant-message",
      threadId: "thread-1",
      sequence: 2,
      _count: { citations: 1 },
    });
    mocks.deleteCitations.mockResolvedValue({ count: 1 });
    mocks.createCitations.mockResolvedValue({ count: 1 });
    mocks.updateMessage.mockResolvedValue({});
    mocks.findOlderMessages.mockResolvedValue([]);
    mocks.updateThread.mockResolvedValue({});
    mocks.updateRun.mockResolvedValue({});
    mocks.updateArtifacts.mockResolvedValue({ count: 1 });
  });

  it("replaces provisional citations after review even when the resumed run is already running", async () => {
    await completeAgentRun({
      runId: "run-resumed-after-review",
      content: "The approved fact now supports the final answer. [citation:1]",
      result: { status: "answered", publicationOutcome: "answered_with_gaps" },
      citations: [{
        kind: "project_fact",
        label: "Approved Project Fact",
        excerpt: "The approved fact now supports the final answer.",
        projectFactId: "fact-1",
      }],
      citationPolicy: "required_inline",
      groundedClaims: [{
        claim: "The approved fact now supports the final answer.",
        citationIndexes: [1],
      }],
    });

    expect(mocks.findAssistant).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        _count: { select: { citations: true } },
      },
    }));
    expect(mocks.deleteCitations).toHaveBeenCalledWith({
      where: { messageId: "assistant-message" },
    });
    expect(mocks.createCitations).toHaveBeenCalledTimes(1);
    expect(mocks.updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          publicationOutcome: "answered_with_gaps",
        }),
      }),
    }));
    expect(mocks.deleteCitations.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createCitations.mock.invocationCallOrder[0]!,
    );
  });

  it("avoids an unnecessary delete for a first-pass answer", async () => {
    mocks.findAssistant.mockResolvedValue({
      id: "assistant-message",
      threadId: "thread-1",
      sequence: 2,
      _count: { citations: 0 },
    });

    await completeAgentRun({
      runId: "run-first-pass",
      content: "The approved fact supports the answer. [citation:1]",
      result: { status: "answered" },
      citations: [{
        kind: "project_fact",
        label: "Approved Project Fact",
        excerpt: "The approved fact supports the answer.",
        projectFactId: "fact-1",
      }],
      citationPolicy: "required_inline",
      groundedClaims: [{
        claim: "The approved fact supports the answer.",
        citationIndexes: [1],
      }],
    });

    expect(mocks.deleteCitations).not.toHaveBeenCalled();
    expect(mocks.createCitations).toHaveBeenCalledTimes(1);
  });

  it("activates a verified Artifact and supersedes its predecessor in the completion lock", async () => {
    mockArtifactProvenance();
    mocks.findAssistant.mockResolvedValue({
      id: "assistant-message",
      threadId: "thread-1",
      sequence: 2,
      _count: { citations: 0 },
    });

    await completeAgentRun({
      runId: "run-artifact",
      content: "Generated Artifact",
      result: { status: "completed", artifactId: "artifact-new" },
      citationPolicy: "none",
      artifactFinalization: {
        artifactId: "artifact-new",
        supersedesArtifactId: "artifact-old",
      },
    });

    expect(mocks.updateArtifacts).toHaveBeenNthCalledWith(1, {
      where: {
        id: "artifact-new",
        originatingAgentRunId: "run-artifact",
        lifecycleStatus: { in: ["quarantined", "active"] },
        publicSafetyStatus: "verified",
      },
      data: {
        lifecycleStatus: "active",
        staleReason: null,
      },
    });
    expect(mocks.updateArtifacts).toHaveBeenNthCalledWith(2, {
      where: {
        id: "artifact-old",
        workItemId: "work-item-1",
        lifecycleStatus: "active",
      },
      data: { lifecycleStatus: "superseded" },
    });
    expect(mocks.updateArtifacts.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.updateRun.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["sensitive", { sensitivityFlag: true }],
    ["private", { visibility: "private" }],
    ["unapproved", { verificationStatus: "draft" }],
    ["superseded", { lifecycleStatus: "superseded" }],
  ])("fails closed when a supporting Highlight becomes %s before activation", async (_label, highlight) => {
    mockArtifactProvenance({ highlight });
    mocks.findAssistant.mockResolvedValue({
      id: "assistant-message",
      threadId: "thread-1",
      sequence: 2,
      _count: { citations: 0 },
    });

    const completion = await completeAgentRun({
      runId: "run-artifact",
      content: "Generated Artifact",
      result: { status: "completed", artifactId: "artifact-new" },
      citationPolicy: "none",
      artifactFinalization: {
        artifactId: "artifact-new",
        supersedesArtifactId: "artifact-old",
      },
    });

    expect(completion).toMatchObject({
      persisted: true,
      status: "insufficient_context",
      message: expect.stringContaining("supporting Highlight"),
    });
    expect(mocks.updateArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.updateArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "artifact-new" }),
      data: expect.objectContaining({
        lifecycleStatus: "quarantined",
        publicSafetyStatus: "failed",
      }),
    }));
    expect(mocks.updateArtifacts).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lifecycleStatus: "active", staleReason: null } }),
    );
    expect(mocks.updateArtifacts).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lifecycleStatus: "superseded" } }),
    );
    expect(mocks.updateRun).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "insufficient_context",
        error: expect.objectContaining({ code: "artifact_provenance_changed" }),
      }),
    }));
  });

  it("fails closed when supporting Evidence is excluded before activation", async () => {
    mockArtifactProvenance({ evidence: { included: false } });
    mocks.findAssistant.mockResolvedValue({
      id: "assistant-message",
      threadId: "thread-1",
      sequence: 2,
      _count: { citations: 1 },
    });

    const completion = await completeAgentRun({
      runId: "run-artifact",
      content: "Generated Artifact",
      result: { status: "completed", artifactId: "artifact-new" },
      citations: [{
        kind: "highlight",
        label: "Supporting Highlight",
        excerpt: "Supporting context",
        highlightId: "highlight-1",
      }],
      citationPolicy: "attached",
      artifactFinalization: {
        artifactId: "artifact-new",
        supersedesArtifactId: "artifact-old",
      },
    });

    expect(completion).toMatchObject({
      persisted: true,
      status: "insufficient_context",
      message: expect.stringContaining("supporting Evidence"),
    });
    expect(mocks.deleteCitations).toHaveBeenCalledWith({
      where: { messageId: "assistant-message" },
    });
    expect(mocks.createCitations).not.toHaveBeenCalled();
    expect(mocks.updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        content: expect.stringContaining("supporting Evidence"),
        status: "completed",
      }),
    }));
    expect(mocks.updateArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.updateArtifacts).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lifecycleStatus: "superseded" } }),
    );
  });

  it("fails closed when supporting Evidence is detached from every used Highlight", async () => {
    mockArtifactProvenance({ linked: false });
    mocks.findAssistant.mockResolvedValue({
      id: "assistant-message",
      threadId: "thread-1",
      sequence: 2,
      _count: { citations: 0 },
    });

    const completion = await completeAgentRun({
      runId: "run-artifact",
      content: "Generated Artifact",
      result: { status: "completed", artifactId: "artifact-new" },
      citationPolicy: "none",
      artifactFinalization: {
        artifactId: "artifact-new",
        supersedesArtifactId: "artifact-old",
      },
    });

    expect(completion).toMatchObject({
      persisted: true,
      status: "insufficient_context",
      message: expect.stringContaining("no longer linked"),
    });
    expect(mocks.updateArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.updateArtifacts).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lifecycleStatus: "active", staleReason: null } }),
    );
    expect(mocks.updateArtifacts).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lifecycleStatus: "superseded" } }),
    );
  });
});
