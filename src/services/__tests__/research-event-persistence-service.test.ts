import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
}));

vi.mock("@/src/services/project-chat-store", () => ({
  appendAgentRunEvent: mocks.append,
}));

import { persistResearchAgentEvent } from "@/src/services/research-event-persistence-service";

describe("project inspection progress events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.append.mockResolvedValue(null);
  });

  it.each([
    {
      knowledgeQueries: [{ query: "architecture", maxResults: 5 }],
      repositoryQueries: [],
      adaptiveRepositorySourceIds: [],
      expectedModes: ["knowledge"],
      expectedMessage: "Searching project knowledge.",
    },
    {
      knowledgeQueries: [],
      repositoryQueries: [{ sourceId: "source-1", args: ["show", "HEAD:README.md"] }],
      adaptiveRepositorySourceIds: [],
      expectedModes: ["repository"],
      expectedMessage: "Inspecting the pinned repository.",
    },
    {
      knowledgeQueries: [{ query: "recent changes", maxResults: 5 }],
      repositoryQueries: [{ sourceId: "source-1", args: ["log", "--oneline", "-10"] }],
      adaptiveRepositorySourceIds: [],
      expectedModes: ["knowledge", "repository"],
      expectedMessage: "Inspecting project knowledge and the pinned repository.",
    },
    {
      knowledgeQueries: [],
      repositoryQueries: [],
      adaptiveRepositorySourceIds: ["source-1"],
      expectedModes: ["repository"],
      expectedMessage: "Inspecting the pinned repository.",
    },
  ])("records evidence mode without exposing the tool input", async ({
    knowledgeQueries,
    repositoryQueries,
    adaptiveRepositorySourceIds,
    expectedModes,
    expectedMessage,
  }) => {
    await persistResearchAgentEvent("run-1", {
      type: "tool_call_started",
      iteration: 1,
      toolCall: 1,
      toolUseId: "tool-1",
      toolName: "inspect_project",
      input: {
        objective: "Answer the project question.",
        knowledgeQueries,
        repositoryQueries,
        adaptiveRepositorySourceIds,
      },
    });

    expect(mocks.append).toHaveBeenCalledWith({
      runId: "run-1",
      type: "tool_call",
      toolName: "inspect_project",
      message: expectedMessage,
      payload: {
        iteration: 1,
        toolCall: 1,
        toolUseId: "tool-1",
        inspectionModes: expectedModes,
      },
    });
    expect(JSON.stringify(mocks.append.mock.calls)).not.toContain("architecture");
    expect(JSON.stringify(mocks.append.mock.calls)).not.toContain("README.md");
  });
});
