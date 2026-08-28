import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

const prismaMock = vi.hoisted(() => ({
  knowledgeRefreshRun: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  agentRun: { findMany: vi.fn(), findUnique: vi.fn() },
  repositoryCapabilityLedger: { upsert: vi.fn() },
  repositorySnapshot: { update: vi.fn() },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveBedrockConfig: () => ({ modelId: "us.anthropic.claude-sonnet-4-6" }),
  resolveActiveTextModelIdentity: () => ({
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6",
  }),
  resolveWorkbaseLlmProvider: () => "mock",
}));

import {
  claimInlineKnowledgeRefreshExecution,
  finalizeKnowledgeCoverage,
  isReusableDegradedChatRefresh,
  isReusableKnowledgeRefresh,
  isKnowledgeRefreshPartial,
  knowledgeRefreshBaseIdempotencyKey,
  pairRepositoryAnalysesByInputOrder,
  policyScopedKnowledgeRefreshIdempotencyKey,
  releaseInlineKnowledgeRefreshExecution,
  repositoryReadExclusionReason,
  repositoryCapabilityPriority,
  repositoryOrchestrationCoverageGaps,
} from "@/src/services/knowledge-refresh-service";

function analysis(input: {
  mode: "static" | "semantic";
  status?: "succeeded" | "degraded";
  unresolvedQuestions?: string[];
}): RepositoryFileAnalysis {
  return {
    path: "src/agent.ts",
    summary: "Implements the project agent runtime.",
    subsystemKeys: ["ai_runtime"],
    responsibilities: ["Runs the project agent."],
    symbols: ["runAgent"],
    dependencies: ["@aws-sdk/client-bedrock-runtime"],
    architectureSignals: ["Bedrock Converse runtime"],
    userFacingCapabilities: [],
    facts: [{
      statement: "The project agent uses Bedrock Converse.",
      category: "architecture",
      confidence: "high",
      sensitivityFlag: false,
      lineStart: 1,
      lineEnd: 12,
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      subsystemKeys: ["ai_runtime"],
      path: "src/agent.ts",
    }],
    unresolvedQuestions: input.unresolvedQuestions ?? [],
    chunksAnalyzed: 1,
    tokenUsage: [],
    analysisMode: input.mode,
    semanticStatus: input.status ?? (input.mode === "semantic" ? "succeeded" : "not_selected"),
    semanticDiagnostics: [],
  };
}

describe("latest-commit freshness barrier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.agentRun.findMany.mockResolvedValue([]);
    prismaMock.repositoryCapabilityLedger.upsert.mockResolvedValue({});
    prismaMock.repositorySnapshot.update.mockResolvedValue({});
    prismaMock.knowledgeRefreshRun.update.mockResolvedValue({});
    prismaMock.knowledgeRefreshRun.updateMany.mockResolvedValue({ count: 0 });
  });

  it("keeps same-path analyses attached to their input repository by position", () => {
    const repositoryAAnalysis = {
      ...analysis({ mode: "static" }),
      path: "README.md",
      summary: "Repository A README",
    };
    const repositoryBAnalysis = {
      ...analysis({ mode: "static" }),
      path: "README.md",
      summary: "Repository B README",
    };
    const paired = pairRepositoryAnalysesByInputOrder({
      pending: [
        { file: { path: "README.md" }, target: { repository: "owner/repository-a" } },
        { file: { path: "README.md" }, target: { repository: "owner/repository-b" } },
      ],
      analyses: [repositoryAAnalysis, repositoryBAnalysis],
    });

    expect(paired.map(({ entry, analysis: result }) => ({
      repository: entry.target.repository,
      summary: result.summary,
    }))).toEqual([
      { repository: "owner/repository-a", summary: "Repository A README" },
      { repository: "owner/repository-b", summary: "Repository B README" },
    ]);
  });

  it("skips content-discovered binary and oversized blobs but preserves operational failures", () => {
    expect(repositoryReadExclusionReason(new Error("binary_file"))).toBe("binary");
    expect(repositoryReadExclusionReason(new Error("file_too_large"))).toBe("oversized");
    expect(repositoryReadExclusionReason(new Error("GitHub request failed"))).toBeNull();
  });

  it("reserves high-priority ledger status for cartographer-selected capabilities", () => {
    expect(repositoryCapabilityPriority({ capabilityKey: "repository_knowledge_lifecycle", observationCount: 4 })).toBe(1);
    expect(repositoryCapabilityPriority({ capabilityKey: "project_domain:payments", observationCount: 4, requiredForSemanticCoverage: true })).toBe(5);
    expect(repositoryCapabilityPriority({ capabilityKey: "project_domain:payments", observationCount: 4 })).toBe(1);
    expect(repositoryCapabilityPriority({ capabilityKey: "module:prisma/schema.prisma", observationCount: 200 })).toBe(3);
    expect(repositoryCapabilityPriority({ capabilityKey: "module:src/utils", observationCount: 3 })).toBe(1);
  });

  it("invalidates same-head refresh reuse when any knowledge policy is stale", () => {
    const target = {
      sourceId: "source-1",
      repository: "workbase/demo",
      branch: "main",
      commitSha: "d".repeat(40),
      treeSha: "e".repeat(40),
      committedAt: null,
      resolvedAt: new Date().toISOString(),
    };
    const currentWarnings = {
      analyzerVersion: "repository-coverage-v21-hybrid",
      semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
      coveragePolicyVersion: "repository-coverage-v13-hybrid",
      orchestrationPolicyVersion: "repository-orchestration-v20-hybrid",
      synthesisPolicyVersion: "repository-synthesis-v41-hybrid",
      lifecyclePolicyVersion: "knowledge-lifecycle-v3",
    };

    expect(isReusableKnowledgeRefresh({
      warnings: { ...currentWarnings, coveragePolicyVersion: "repository-coverage-v5" },
      qualityStatus: "verified",
      completedTargets: [target],
      targets: [target],
    })).toBe(false);
    expect(isReusableKnowledgeRefresh({
      warnings: { ...currentWarnings, orchestrationPolicyVersion: "repository-orchestration-v4" },
      qualityStatus: "verified",
      completedTargets: [target],
      targets: [target],
    })).toBe(false);
    expect(isReusableKnowledgeRefresh({
      warnings: { ...currentWarnings, lifecyclePolicyVersion: "knowledge-lifecycle-v2" },
      qualityStatus: "verified",
      completedTargets: [target],
      targets: [target],
    })).toBe(false);
    expect(isReusableKnowledgeRefresh({
      warnings: currentWarnings,
      qualityStatus: "verified",
      completedTargets: [target],
      targets: [target],
    })).toBe(true);
    expect(policyScopedKnowledgeRefreshIdempotencyKey("chat:same-head"))
      .toMatch(/^chat:same-head:policy:[a-f0-9]{16}$/);
  });

  it("coalesces every ordinary refresh trigger at the same immutable heads", () => {
    const targets = [
      { sourceId: "source-b", commitSha: "b".repeat(40) },
      { sourceId: "source-a", commitSha: "a".repeat(40) },
    ];
    const ordinaryKeys = ([
      ["repository_attach", "attach:first"],
      ["scheduled", "scheduled:first"],
      ["manual", "manual:first"],
      ["chat_freshness", "agent-run:first:freshness"],
    ] as const).map(([trigger, requestedKey]) => knowledgeRefreshBaseIdempotencyKey({
      trigger,
      requestedKey,
      targets: trigger === "scheduled" ? [...targets].reverse() : targets,
    }));

    expect(new Set(ordinaryKeys)).toHaveLength(1);
    expect(ordinaryKeys[0]).toMatch(/^repository_heads:[a-f0-9]{64}$/);
    expect(knowledgeRefreshBaseIdempotencyKey({
      trigger: "backfill",
      requestedKey: "knowledge-edit:fact-1",
      targets,
    })).toBe("knowledge-edit:fact-1");
  });

  it("allows one inline chat workflow to own a shared refresh while later turns wait", async () => {
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    prismaMock.knowledgeRefreshRun.findUnique
      .mockResolvedValueOnce({
        status: "analyzing",
        workflowId: "inline-agent:first",
        startedAt: new Date("2026-07-16T10:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        status: "analyzing",
        workflowId: "inline-agent:first",
        startedAt: new Date("2026-07-16T10:00:00.000Z"),
      });
    prismaMock.agentRun.findUnique.mockResolvedValue({
      status: "running",
    });

    await expect(claimInlineKnowledgeRefreshExecution({
      runId: "refresh-shared",
      ownerToken: "inline-agent:first",
    })).resolves.toBe(true);
    await expect(claimInlineKnowledgeRefreshExecution({
      runId: "refresh-shared",
      ownerToken: "inline-agent:first",
    })).resolves.toBe(true);
    await expect(claimInlineKnowledgeRefreshExecution({
      runId: "refresh-shared",
      ownerToken: "inline-agent:second",
    })).resolves.toBe(false);

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "refresh-shared",
          status: "queued",
          workflowId: null,
        }),
        data: expect.objectContaining({
          status: "inventorying",
          workflowId: "inline-agent:first",
        }),
      }),
    );
  });

  it("does not infer a safe ownership handoff from terminal AgentRun state", async () => {
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    prismaMock.knowledgeRefreshRun.findUnique.mockResolvedValue({
      status: "semantic_analysis",
      workflowId: "inline-agent:cancelled-owner",
      startedAt: new Date("2026-07-16T10:00:00.000Z"),
    });
    prismaMock.agentRun.findUnique.mockResolvedValue({ status: "cancelled" });

    await expect(claimInlineKnowledgeRefreshExecution({
      runId: "refresh-shared",
      ownerToken: "inline-agent:replacement",
    })).resolves.toBe(false);
    expect(prismaMock.agentRun.findUnique).not.toHaveBeenCalled();
  });

  it("claims an ownerless active refresh without resetting its checkpoint status", async () => {
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(claimInlineKnowledgeRefreshExecution({
      runId: "refresh-ownerless",
      ownerToken: "inline-agent:replacement",
    })).resolves.toBe(true);

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: "refresh-ownerless",
        status: {
          in: [
            "inventorying",
            "analyzing",
            "routing",
            "semantic_analysis",
            "auditing",
            "reconciling",
          ],
        },
        workflowId: null,
      },
      data: {
        workflowId: "inline-agent:replacement",
        finishedAt: null,
      },
    });
  });

  it("preserves the original start boundary when a released refresh is resumed", async () => {
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(claimInlineKnowledgeRefreshExecution({
      runId: "refresh-resumed",
      ownerToken: "inline-agent:replacement",
    })).resolves.toBe(true);

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "refresh-resumed",
        status: "queued",
        workflowId: null,
        startedAt: { not: null },
      },
      data: {
        status: "inventorying",
        workflowId: "inline-agent:replacement",
        finishedAt: null,
      },
    });
  });

  it("releases only the cancelling inline owner without clobbering a successor", async () => {
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(releaseInlineKnowledgeRefreshExecution({
      runId: "refresh-shared",
      ownerToken: "inline-agent:first",
    })).resolves.toBe(true);
    await expect(releaseInlineKnowledgeRefreshExecution({
      runId: "refresh-shared",
      ownerToken: "inline-agent:first",
    })).resolves.toBe(false);

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "refresh-shared",
          workflowId: "inline-agent:first",
        }),
        data: {
          status: "queued",
          workflowId: null,
          finishedAt: null,
        },
      }),
    );
  });

  it("briefly reuses a same-head degraded chat refresh without calling it verified", () => {
    const target = {
      sourceId: "source-1",
      repository: "workbase/demo",
      branch: "main",
      commitSha: "d".repeat(40),
      treeSha: "e".repeat(40),
      committedAt: null,
      resolvedAt: new Date().toISOString(),
    };
    const warnings = {
      analyzerVersion: "repository-coverage-v21-hybrid",
      semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
      coveragePolicyVersion: "repository-coverage-v13-hybrid",
      orchestrationPolicyVersion: "repository-orchestration-v20-hybrid",
      synthesisPolicyVersion: "repository-synthesis-v41-hybrid",
      lifecyclePolicyVersion: "knowledge-lifecycle-v3",
    };
    const now = new Date("2026-07-15T12:15:00.000Z");

    expect(isReusableDegradedChatRefresh({
      warnings,
      qualityStatus: "degraded",
      completedTargets: [target],
      targets: [target],
      finishedAt: new Date("2026-07-15T12:05:00.000Z"),
      now,
    })).toBe(true);
    expect(isReusableDegradedChatRefresh({
      warnings,
      qualityStatus: "verified",
      completedTargets: [target],
      targets: [target],
      finishedAt: new Date("2026-07-15T12:05:00.000Z"),
      now,
    })).toBe(false);
    expect(isReusableDegradedChatRefresh({
      warnings,
      qualityStatus: "degraded",
      completedTargets: [target],
      targets: [{ ...target, commitSha: "f".repeat(40) }],
      finishedAt: new Date("2026-07-15T12:05:00.000Z"),
      now,
    })).toBe(false);
    expect(isReusableDegradedChatRefresh({
      warnings: { ...warnings, orchestrationPolicyVersion: "repository-orchestration-v7" },
      qualityStatus: "degraded",
      completedTargets: [target],
      targets: [target],
      finishedAt: new Date("2026-07-15T12:05:00.000Z"),
      now,
    })).toBe(false);
    expect(isReusableDegradedChatRefresh({
      warnings,
      qualityStatus: "degraded",
      completedTargets: [target],
      targets: [target],
      finishedAt: new Date("2026-07-15T11:59:59.000Z"),
      now,
    })).toBe(false);
  });

  it("refuses to finalize while any eligible repository file lacks analysis", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-1",
      targetHeads: [{
        sourceId: "source-1",
        repository: "workbase/demo",
        branch: "main",
        commitSha: "d".repeat(40),
        treeSha: "e".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      snapshots: [{
        id: "snapshot-1",
        sourceId: "source-1",
        commitSha: "d".repeat(40),
        files: [{ path: "src/unread.ts", disposition: "eligible", analysis: null }],
      }],
    });

    await expect(finalizeKnowledgeCoverage("refresh-1")).rejects.toThrow(
      "Repository analysis is incomplete for 1 eligible file.",
    );
    expect(prismaMock.repositorySnapshot.update).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeRefreshRun.update).not.toHaveBeenCalled();
  });

  it("propagates degraded semantic analysis into overall coverage and refresh quality", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-item-1",
      targetHeads: [{
        sourceId: "source-1",
        repository: "workbase/demo",
        branch: "main",
        commitSha: "d".repeat(40),
        treeSha: "e".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      warnings: null,
      snapshots: [{
        id: "snapshot-1",
        sourceId: "source-1",
        commitSha: "d".repeat(40),
        files: [{
          id: "file-1",
          path: "src/agent.ts",
          disposition: "analyzed",
          analyzerVersion: "repository-coverage-v21-hybrid",
          analysis: analysis({ mode: "static" }),
          semanticStatus: "degraded",
          semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
          semanticRefreshRunId: "refresh-1",
          semanticAnalysis: analysis({ mode: "semantic", status: "degraded" }),
        }],
      }],
    });

    const result = await finalizeKnowledgeCoverage("refresh-1");

    expect(result.coverage).toEqual([
      expect.objectContaining({
        coverageStatus: "failed",
        semanticCoverageStatus: "failed",
        capabilityCoverageStatus: "failed",
        semanticPaths: 0,
        coverageGaps: expect.arrayContaining([
          "Search, retrieval, and model intelligence does not meet its repository-derived semantic sample and implementation-evidence target.",
          "Semantic analysis degraded for src/agent.ts.",
        ]),
      }),
    ]);
    expect(prismaMock.repositorySnapshot.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ coverageComplete: false }),
    }));
    expect(prismaMock.knowledgeRefreshRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ qualityStatus: "degraded" }),
    }));
  });

  it("does not let a successful model's informational question degrade verified coverage", async () => {
    prismaMock.agentRun.findMany.mockResolvedValue([
      {
        id: "worker-intelligence",
        request: {
          capabilityKeys: ["repository_area:intelligence"],
          fileSnapshotIds: ["file-1", "file-from-another-repository"],
        },
        result: {
          inspectedFileSnapshotIds: ["file-1", "file-that-failed-before-read"],
        },
      },
      {
        id: "worker-failed-before-read",
        request: {
          capabilityKeys: ["repository_area:intelligence"],
          fileSnapshotIds: ["file-1"],
        },
        result: { inspectedFileSnapshotIds: [] },
      },
    ]);
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-item-1",
      targetHeads: [{
        sourceId: "source-1",
        repository: "workbase/demo",
        branch: "main",
        commitSha: "d".repeat(40),
        treeSha: "e".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      warnings: null,
      snapshots: [{
        id: "snapshot-1",
        sourceId: "source-1",
        commitSha: "d".repeat(40),
        files: [{
          id: "file-1",
          path: "src/agent.ts",
          disposition: "analyzed",
          analyzerVersion: "repository-coverage-v21-hybrid",
          analysis: analysis({ mode: "static" }),
          semanticStatus: "succeeded",
          semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
          semanticRefreshRunId: "refresh-1",
          semanticAnalysis: analysis({
            mode: "semantic",
            status: "succeeded",
            unresolvedQuestions: [
              "What condition distinguishes a degraded fallback from a failed outcome in omitted lines?",
            ],
          }),
        }],
      }],
    });

    const result = await finalizeKnowledgeCoverage("refresh-1");

    expect(result.coverage).toEqual([
      expect.objectContaining({
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        semanticPaths: 1,
        coverageGaps: [],
      }),
    ]);
    const intelligenceLedgerCall = prismaMock.repositoryCapabilityLedger.upsert.mock.calls
      .map(([input]) => input)
      .find((input) => input.create.capabilityKey === "repository_area:intelligence");
    expect(intelligenceLedgerCall).toMatchObject({
      create: {
        status: "semantic_verified",
        gaps: [],
        representativeFileIds: ["file-1"],
        workerRunIds: ["worker-intelligence"],
      },
      update: {
        status: "semantic_verified",
        gaps: [],
        representativeFileIds: ["file-1"],
        workerRunIds: ["worker-intelligence"],
      },
    });
    expect(prismaMock.knowledgeRefreshRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        qualityStatus: "verified",
        warnings: expect.objectContaining({
          analyzerVersion: "repository-coverage-v21-hybrid",
          semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
          coveragePolicyVersion: "repository-coverage-v13-hybrid",
          orchestrationPolicyVersion: "repository-orchestration-v20-hybrid",
          synthesisPolicyVersion: "repository-synthesis-v41-hybrid",
          lifecyclePolicyVersion: "knowledge-lifecycle-v3",
        }),
      }),
    }));
  });

  it("does not turn path-inferred static capabilities into semantic evidence", async () => {
    const path = "src/app/api/v1/auth/login/route.test.ts";
    const staticAnalysis: RepositoryFileAnalysis = {
      ...analysis({ mode: "static" }),
      path,
      subsystemKeys: ["tests_operations", "project_domain:auth", "module:src/app"],
      facts: [{
        ...analysis({ mode: "static" }).facts[0]!,
        path,
        evidenceMode: "static",
        subsystemKeys: ["tests_operations", "project_domain:auth", "module:src/app"],
      }],
    };
    const semanticAnalysis: RepositoryFileAnalysis = {
      ...analysis({ mode: "semantic", status: "succeeded" }),
      path,
      subsystemKeys: ["tests_operations", "project_domain:auth", "module:src/app"],
      facts: [{
        ...analysis({ mode: "semantic", status: "succeeded" }).facts[0]!,
        path,
        evidenceMode: "semantic",
        subsystemKeys: ["project_domain:auth"],
      }],
    };
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-auth",
      workItemId: "work-item-1",
      targetHeads: [{
        sourceId: "source-1",
        repository: "workbase/demo",
        branch: "main",
        commitSha: "d".repeat(40),
        treeSha: "e".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      warnings: null,
      snapshots: [{
        id: "snapshot-1",
        sourceId: "source-1",
        commitSha: "d".repeat(40),
        files: [{
          id: "file-auth",
          path,
          disposition: "analyzed",
          analyzerVersion: "repository-coverage-v21-hybrid",
          analysis: staticAnalysis,
          semanticStatus: "succeeded",
          semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
          semanticRefreshRunId: "refresh-auth",
          semanticAnalysis,
        }],
      }],
    });

    const result = await finalizeKnowledgeCoverage("refresh-auth");

    expect(result.coverage).toEqual([
      expect.objectContaining({
        coverageStatus: "partial",
        coverageGaps: expect.arrayContaining([
          "Quality and operations does not meet its repository-derived semantic sample and implementation-evidence target.",
        ]),
      }),
    ]);
    const ledgerCalls = prismaMock.repositoryCapabilityLedger.upsert.mock.calls
      .map(([input]) => input);
    expect(ledgerCalls.find((input) => input.create.capabilityKey === "repository_area:quality"))
      .toMatchObject({
        create: { status: "static_only", semanticObservationCount: 0 },
        update: { status: "static_only", semanticObservationCount: 0 },
      });
    expect(ledgerCalls.find((input) => input.create.capabilityKey === "repository_area:product_surface"))
      .toBeUndefined();
  });

  it("uses the independent critic instead of certifying a domain from one successful file", async () => {
    const domainAnalysis = (mode: "static" | "semantic"): RepositoryFileAnalysis => ({
      ...analysis({ mode, status: mode === "semantic" ? "succeeded" : undefined }),
      path: "src/payments/charge.ts",
      subsystemKeys: ["project_domain:payments"],
      facts: [{
        ...analysis({ mode }).facts[0]!,
        path: "src/payments/charge.ts",
        subsystemKeys: ["project_domain:payments"],
        evidenceMode: mode === "semantic" ? "semantic" : "static",
      }],
    });
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-payments",
      workItemId: "work-item-1",
      targetHeads: [{
        sourceId: "source-1",
        repository: "owner/commerce",
        branch: "main",
        commitSha: "d".repeat(40),
        treeSha: "e".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      warnings: null,
      orchestration: {
        cartography: [{
          key: "project_domain:payments",
          label: "Payments",
          scopeKey: "owner/commerce",
          salience: 60,
          files: [
            { id: "charge", path: "src/payments/charge.ts", score: 30 },
            { id: "ledger", path: "src/payments/ledger.ts", score: 20 },
            { id: "refund", path: "src/payments/refund.ts", score: 10 },
          ],
        }],
        coverageCritique: {
          domains: [{
            key: "project_domain:payments",
            label: "Payments",
            scopeKey: "owner/commerce",
            totalFiles: 3,
            targetSamples: 2,
            inspectedSamples: 1,
            supportedCandidates: 1,
            status: "thin",
          }],
        },
        remainingGaps: ["Payments in owner/commerce has only 1 of 2 required semantic samples."],
      },
      snapshots: [{
        id: "snapshot-1",
        sourceId: "source-1",
        commitSha: "d".repeat(40),
        files: [
          {
            id: "charge",
            path: "src/payments/charge.ts",
            disposition: "analyzed",
            analyzerVersion: "repository-coverage-v21-hybrid",
            analysis: domainAnalysis("static"),
            semanticStatus: "succeeded",
            semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
            semanticRefreshRunId: "refresh-payments",
            semanticAnalysis: domainAnalysis("semantic"),
          },
          ...["ledger", "refund"].map((id) => ({
            id,
            path: `src/payments/${id}.ts`,
            disposition: "analyzed",
            analyzerVersion: "repository-coverage-v21-hybrid",
            analysis: { ...domainAnalysis("static"), path: `src/payments/${id}.ts` },
            semanticStatus: "not_selected",
            semanticAnalyzerVersion: null,
            semanticRefreshRunId: null,
            semanticAnalysis: null,
          })),
        ],
      }],
    });

    const result = await finalizeKnowledgeCoverage("refresh-payments");

    expect(result.coverage).toEqual([
      expect.objectContaining({
        coverageStatus: "partial",
        capabilityCoverageStatus: "partial",
        targets: [expect.objectContaining({
          key: "project_domain:payments",
          criticStatus: "thin",
          semanticPathCount: 1,
        })],
      }),
    ]);
    expect(prismaMock.repositoryCapabilityLedger.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        capabilityKey: "project_domain:payments",
        status: "partial",
      }),
    }));
  });

  it("preserves repository-scoped semantic capacity gaps through final coverage", async () => {
    const target = (sourceId: string, repository: string) => ({
      sourceId,
      repository,
      branch: "main",
      commitSha: sourceId.repeat(40).slice(0, 40),
      treeSha: "e".repeat(40),
      committedAt: null,
      resolvedAt: new Date().toISOString(),
    });
    const file = (id: string) => ({
      id,
      path: "src/agent.ts",
      disposition: "analyzed",
      analyzerVersion: "repository-coverage-v21-hybrid",
      analysis: analysis({ mode: "static" }),
      semanticStatus: "succeeded",
      semanticAnalyzerVersion: "repository-coverage-v21-hybrid",
      semanticRefreshRunId: "refresh-multi",
      semanticAnalysis: analysis({ mode: "semantic", status: "succeeded" }),
    });
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      id: "refresh-multi",
      workItemId: "work-item-1",
      targetHeads: [target("a", "owner/repo-a"), target("b", "owner/repo-b")],
      warnings: null,
      orchestration: {
        remainingGaps: ["Semantic coverage capacity omitted ai_runtime for owner/repo-b."],
      },
      snapshots: [
        { id: "snapshot-a", sourceId: "a", commitSha: "a".repeat(40), files: [file("file-a")] },
        { id: "snapshot-b", sourceId: "b", commitSha: "b".repeat(40), files: [file("file-b")] },
      ],
    });

    const result = await finalizeKnowledgeCoverage("refresh-multi");

    expect(result.coverage).toEqual([
      expect.objectContaining({ repository: "owner/repo-a", coverageStatus: "complete", coverageGaps: [] }),
      expect.objectContaining({
        repository: "owner/repo-b",
        coverageStatus: "partial",
        capabilityCoverageStatus: "partial",
        coverageGaps: ["Semantic coverage capacity omitted ai_runtime for owner/repo-b."],
      }),
    ]);
    expect(prismaMock.knowledgeRefreshRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        qualityStatus: "degraded",
        warnings: expect.objectContaining({
          semanticOrchestrationGaps: ["Semantic coverage capacity omitted ai_runtime for owner/repo-b."],
        }),
      }),
    }));
  });

  it("keeps unscoped orchestration failures conservatively visible", () => {
    expect(repositoryOrchestrationCoverageGaps({
      repository: "owner/repo-a",
      repositories: ["owner/repo-a", "owner/repo-b"],
      filePaths: ["src/agent.ts"],
      remainingGaps: [
        "Semantic coverage capacity omitted ai_runtime for owner/repo-b.",
        "Assigned semantic file missing-id was unavailable in the current repository refresh.",
      ],
    })).toEqual([
      "Assigned semantic file missing-id was unavailable in the current repository refresh.",
    ]);
  });

  it("derives partial state from semantic quality and coverage instead of inventory alone", () => {
    expect(isKnowledgeRefreshPartial({
      qualityStatus: "degraded",
      coverage: [{ coverageStatus: "complete", semanticCoverageStatus: "partial", coverageGaps: [] }],
    })).toBe(true);
    expect(isKnowledgeRefreshPartial({
      qualityStatus: "verified",
      coverage: [{ coverageStatus: "complete", semanticCoverageStatus: "complete", capabilityCoverageStatus: "verified", coverageGaps: [] }],
    })).toBe(false);
  });
});
