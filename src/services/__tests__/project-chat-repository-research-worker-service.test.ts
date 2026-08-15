import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BedrockConverseAgentRunResult } from "@/src/lib/bedrock-converse-agent";
import type { ProjectChatRepositoryInspector } from "@/src/services/project-chat-repository-inspection-service";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  audit: vi.fn(),
  createAgent: vi.fn(),
}));

vi.mock("@/src/services/bedrock-runtime", () => ({
  createTextConverseAgent: (options: unknown) => {
    mocks.createAgent(options);
    return { run: mocks.run };
  },
}));

vi.mock("@/src/services/project-chat-model-audit-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/src/services/project-chat-model-audit-service")
  >()),
  runAuditedProjectChatModel: mocks.audit,
}));

import {
  PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_LIMITS,
  runProjectChatRepositoryResearchWorker,
} from "@/src/services/project-chat-repository-research-worker-service";

function runResult(text: string): BedrockConverseAgentRunResult {
  return {
    text,
    assistantMessage: { role: "assistant", content: [{ text }] },
    messages: [],
    stopReason: "end_turn",
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
    events: [],
    iterations: 2,
    toolCalls: 1,
    requestIds: ["request-worker"],
  };
}

describe("isolated project repository research worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockImplementation(async (input) => {
      const executed = await input.execute();
      return {
        checkpoint: {
          version: "project-chat-model-checkpoint-v11",
          answer: executed.result.text,
          catalog: executed.checkpoint.catalog,
          entries: executed.checkpoint.entries,
          research: null,
          toolNames: ["inspect_repository_snapshot"],
          repositoryResearchUsed: true,
          supportingGenerationRunIds: [],
          control: executed.checkpoint.control,
        },
        generationRunId: "generation-worker",
        replayed: false,
      };
    });
  });

  it("uses a fresh bounded context and returns only a compact cited handoff", async () => {
    const inspect = vi.fn().mockResolvedValue({
      status: "completed",
      snapshot: {
        sourceId: "source-1",
        repository: "acme/payments",
        commitSha: "a".repeat(40),
        defaultBranch: "main",
        committedAt: null,
        commitUrl: `https://github.com/acme/payments/commit/${"a".repeat(40)}`,
      },
      results: [{
        args: ["log", "--format=%h %an %s", "-5"],
        status: "success",
        exitCode: 0,
        evidenceId: "evidence-1234567890",
        outputHash: "output-hash",
        totalBytes: 80_000,
        totalLines: 900,
        truncated: true,
        segments: [{
          evidenceId: "evidence-1234567890",
          segmentId: "segment-1",
          sourceId: "source-1",
          repository: "acme/payments",
          commitSha: "a".repeat(40),
          args: ["log", "--format=%h %an %s", "-5"],
          command: "git log --format=%h %an %s -5",
          excerpt: "a1b2c3 Ada add reconciliation retry",
          excerptHash: "excerpt-hash",
          outputHash: "output-hash",
          startLine: 441,
          endLine: 441,
          totalLines: 900,
          totalBytes: 80_000,
          truncated: true,
        }],
      }],
      expansions: [],
      remainingQueryBudget: 9,
    });
    const inspector = {
      summaries: () => [{
        sourceId: "source-1",
        repository: "acme/payments",
        capabilities: ["git_inspection"],
      }],
      inspect,
    } as unknown as ProjectChatRepositoryInspector;
    mocks.run.mockImplementation(async (input) => {
      expect(input.messages).toHaveLength(1);
      expect(JSON.stringify(input.messages)).toContain("Who introduced retry handling");
      expect(JSON.stringify(input.messages)).not.toContain("parent answer transcript");
      expect(input.tools).toHaveLength(1);
      await input.tools[0]!.execute({
        repositoryQueries: [{
          sourceId: "source-1",
          args: ["log", "--format=%h %an %s", "-5"],
        }],
        repositoryExpansions: [],
      });
      return runResult("Ada introduced the retry change. [citation:1]");
    });

    const result = await runProjectChatRepositoryResearchWorker({
      runId: "run-1",
      workItemId: "work-1",
      phase: "initial",
      objective: "Who introduced retry handling and in which change?",
      sourceIds: ["source-1"],
      repositoryInspector: inspector,
    });

    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      attempt: "repository_research_1",
      phase: "initial",
    }));
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultLimits: PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_LIMITS,
    }));
    expect(PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_LIMITS.maxIterations).toBeGreaterThan(
      PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_LIMITS.maxToolCalls,
    );
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "source-1",
      objective: "Who introduced retry handling and in which change?",
    }));
    expect(result).toMatchObject({
      summary: "Ada introduced the retry change. [citation:1]",
      generationRunId: "generation-worker",
      partial: false,
      catalog: [{
        repository: "acme/payments",
        evidenceHandle: "evidence-1234567890",
        sourceStartLine: 441,
        sourceEndLine: 441,
      }],
      entries: [{ citationIndexes: [1] }],
    });
    expect(JSON.stringify(result)).not.toContain("line 442");
  });

  it("rejects repository IDs outside the delegated objective", async () => {
    const inspect = vi.fn();
    const inspector = {
      summaries: () => [],
      inspect,
    } as unknown as ProjectChatRepositoryInspector;
    mocks.run.mockImplementation(async (input) => {
      const response = await input.tools[0]!.execute({
        repositoryQueries: [{
          sourceId: "source-not-authorized",
          args: ["log", "-3"],
        }],
        repositoryExpansions: [],
      });
      expect(response).toMatchObject({
        status: "rejected",
        code: "source_not_authorized",
      });
      return runResult("The delegated source was not authorized.");
    });
    await runProjectChatRepositoryResearchWorker({
      runId: "run-1",
      workItemId: "work-1",
      phase: "initial",
      objective: "Inspect the project history",
      sourceIds: ["source-1"],
      repositoryInspector: inspector,
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not disguise a local audit failure as a partial research result", async () => {
    const inspect = vi.fn().mockResolvedValue({
      status: "completed",
      snapshot: {
        sourceId: "source-1",
        repository: "acme/payments",
        commitSha: "a".repeat(40),
        defaultBranch: "main",
        committedAt: null,
        commitUrl: `https://github.com/acme/payments/commit/${"a".repeat(40)}`,
      },
      results: [{
        args: ["show", "HEAD:src/retry.ts"],
        status: "success",
        exitCode: 0,
        evidenceId: "evidence-1234567890",
        outputHash: "output-hash",
        totalBytes: 80,
        totalLines: 1,
        truncated: false,
        segments: [{
          evidenceId: "evidence-1234567890",
          segmentId: "segment-1",
          sourceId: "source-1",
          repository: "acme/payments",
          commitSha: "a".repeat(40),
          args: ["show", "HEAD:src/retry.ts"],
          command: "git show HEAD:src/retry.ts",
          excerpt: "export const retryLimit = 6;",
          excerptHash: "excerpt-hash",
          outputHash: "output-hash",
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          totalBytes: 80,
          truncated: false,
        }],
      }],
      expansions: [],
      remainingQueryBudget: 9,
    });
    const inspector = {
      summaries: () => [{
        sourceId: "source-1",
        repository: "acme/payments",
        capabilities: ["git_inspection"],
      }],
      inspect,
    } as unknown as ProjectChatRepositoryInspector;
    mocks.run.mockImplementation(async (input) => {
      await input.tools[0]!.execute({
        repositoryQueries: [{
          sourceId: "source-1",
          args: ["show", "HEAD:src/retry.ts"],
        }],
        repositoryExpansions: [],
      });
      return runResult("The retry limit is six. [citation:1]");
    });
    mocks.audit.mockImplementationOnce(async (input) => {
      await input.execute();
      throw new Error("audit persistence unavailable");
    });

    await expect(runProjectChatRepositoryResearchWorker({
      runId: "run-1",
      workItemId: "work-1",
      phase: "initial",
      objective: "Find the retry limit",
      sourceIds: ["source-1"],
      repositoryInspector: inspector,
    })).rejects.toThrow("audit persistence unavailable");
    expect(inspect).toHaveBeenCalledOnce();
  });
});
