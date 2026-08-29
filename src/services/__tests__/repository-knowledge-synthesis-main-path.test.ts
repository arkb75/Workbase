import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredGenerationBudget } from "@/src/lib/bedrock-structured-llm-client";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

const generateStructuredMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  knowledgeRefreshRun: {
    findUniqueOrThrow: vi.fn(),
  },
  generationRun: {
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveActiveTextModelIdentity: () => ({
    provider: "bedrock",
    modelId: "synthesis-model",
  }),
}));
vi.mock("@/src/services/bedrock-runtime", () => ({
  getStructuredLlmClient: () => ({
    generateStructured: generateStructuredMock,
  }),
}));

import {
  repositoryEvidenceBoundaryGuidance,
  repositorySynthesisBudgetLimits,
  synthesizeRepositoryKnowledge,
} from "@/src/services/repository-knowledge-synthesis-service";
import { REPOSITORY_SEMANTIC_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

const statement =
  "The charge service records an idempotency key before publishing a payment receipt.";
const path = "src/payments/charge-service.ts";
const sourceExcerpt = [
  "10: await idempotencyKeys.insert(key);",
  "11: await receipts.publish(receipt);",
].join("\n");

function semanticAnalysis(): RepositoryFileAnalysis {
  return {
    path,
    summary: "Idempotent payment receipt publication.",
    subsystemKeys: ["project_domain:payments"],
    responsibilities: [],
    symbols: [],
    dependencies: [],
    architectureSignals: [],
    userFacingCapabilities: [],
    unresolvedQuestions: [],
    chunksAnalyzed: 1,
    tokenUsage: [],
    analysisMode: "semantic",
    semanticStatus: "succeeded",
    semanticSource: "model",
    facts: [
      {
        statement,
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 10,
        lineEnd: 18,
        productImportance: 5,
        implementationBreadth: 3,
        technicalDifficulty: 4,
        path,
        subsystemKeys: ["project_domain:payments"],
        semanticSignals: ["domain.payment_idempotency"],
        evidenceExcerpt: sourceExcerpt,
        evidenceMode: "semantic",
      },
      {
        statement: "The charge service records request latency for diagnostics.",
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 20,
        lineEnd: 22,
        productImportance: 1,
        implementationBreadth: 1,
        technicalDifficulty: 1,
        path,
        subsystemKeys: ["project_domain:payments"],
        semanticSignals: [],
        evidenceExcerpt: "20: metrics.recordLatency(elapsedMs);",
        evidenceMode: "semantic",
      },
    ],
  };
}

function refreshRun() {
  return {
    id: "refresh-1",
    workItemId: "work-item-1",
    orchestration: {
      packages: [{ capabilityKeys: ["project_domain:payments"] }],
    },
    targetHeads: [{
      sourceId: "source-1",
      repository: "acme/ledger-platform",
      branch: "main",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: null,
      resolvedAt: new Date().toISOString(),
    }],
    workItem: { title: "Ledger Platform" },
    snapshots: [{
      sourceId: "source-1",
      commitSha: "a".repeat(40),
      files: [{
        path,
        blobSha: "blob-charge-service",
        analyzerVersion: null,
        analysis: null,
        semanticRefreshRunId: "refresh-1",
        semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
        semanticStatus: "succeeded",
        semanticAnalysis: semanticAnalysis(),
        changeType: "modified",
      }],
    }],
  };
}

function chargeBudget(budget: StructuredGenerationBudget | undefined) {
  if (!budget) return;
  budget.usage.modelCalls += 1;
  budget.usage.inputTokens += 100;
  budget.usage.outputTokens += 50;
  budget.usage.totalTokens += 150;
}

describe("repository synthesis model main path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("WORKBASE_REPOSITORY_SYNTHESIS_MODE", "model");
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue(refreshRun());
    prismaMock.generationRun.upsert.mockImplementation(async (input) => ({
      id: `generation-${input.create.inputSummary.phase}`,
      provider: "bedrock",
      modelId: "synthesis-model",
      tokenUsage: null,
      resultRefs: null,
      estimatedCostUsd: null,
    }));
    prismaMock.generationRun.update.mockResolvedValue({});
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
          notebook?: Array<{ sourceExcerpt?: string | null }>;
        }>;
      };
      const data = request.schemaName === "repository_architecture_synthesis"
        ? {
            subsystems: [{
              subsystemKey: prompt.subsystems[0]!.subsystemKey,
              facts: [{
                statement,
                category: "behavior",
                confidence: "high",
                sensitivityFlag: false,
                citationIndexes: [1],
                reviewNotes: null,
                productImportance: 5,
                implementationBreadth: 3,
                technicalDifficulty: 4,
                distinctiveness: 4,
              }],
              highlights: [],
              unresolvedQuestions: [],
            }],
          }
        : {
            assessments: [{
              claimKey: prompt.subsystems[0]!.claims![0]!.claimKey,
              supported: true,
              issues: [],
            }],
          };
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          requestId: `request-${request.schemaName}`,
        },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
        requestId: `request-${request.schemaName}`,
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs and durably attests synthesis followed by its independent critic", async () => {
    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock).toHaveBeenCalledTimes(2);
    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
    ]);
    expect(generateStructuredMock.mock.calls[0]![0]).toMatchObject({
      maxTokens: 10_000,
      effort: "medium",
    });
    expect(generateStructuredMock.mock.calls[1]![0]).toMatchObject({
      maxTokens: 2_000,
      effort: "low",
      enablePromptCaching: false,
    });
    const synthesisPrompt = JSON.parse(generateStructuredMock.mock.calls[0]![0].userPrompt);
    const criticPrompt = JSON.parse(generateStructuredMock.mock.calls[1]![0].userPrompt);
    expect(synthesisPrompt.subsystems[0].notebook[0].sourceExcerpt).toBe(sourceExcerpt);
    expect(criticPrompt.subsystems[0].notebook[0]).toEqual({
      index: 1,
      sourceExcerpt,
    });
    expect(generateStructuredMock.mock.calls[1]![0].systemPrompt).toContain(
      "Each supplied sourceExcerpt contains the exact bounded source fragment",
    );
    expect(generateStructuredMock.mock.calls[0]![0].systemPrompt).toContain(
      "sourceExcerpt contains the exact bounded source fragments",
    );
    expect(synthesis).toEqual([
      expect.objectContaining({
        subsystemKey: "project_domain:payments",
        approvalEligible: true,
        facts: [expect.objectContaining({ statement, citationIndexes: [1] })],
      }),
    ]);

    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([input]) =>
      input.create.inputSummary
    );
    expect(summaries).toEqual([
      expect.objectContaining({
        phase: "synthesis",
        refreshRunId: "refresh-1",
        subsystemKeys: [expect.stringMatching(/^project_domain:payments#/)],
      }),
      expect.objectContaining({
        phase: "entailment_critic",
        refreshRunId: "refresh-1",
        subsystemKeys: [expect.stringMatching(/^project_domain:payments#/)],
        claimCount: 1,
      }),
    ]);
    const persisted = prismaMock.generationRun.update.mock.calls.map(([input]) =>
      input.data.parsedOutput
    );
    expect(persisted[0]).toEqual(expect.objectContaining({
      subsystems: [expect.objectContaining({
        facts: [expect.objectContaining({ statement, citationIndexes: [1] })],
      })],
    }));
    expect(persisted[1]).toEqual(expect.objectContaining({
      assessments: [expect.objectContaining({ supported: true })],
    }));

    const synthesisBudget = generateStructuredMock.mock.calls[0]![0].budget;
    expect(generateStructuredMock.mock.calls[1]![0].budget).toBe(synthesisBudget);
    expect(synthesisBudget).toMatchObject({
      limits: repositorySynthesisBudgetLimits(1),
      usage: {
        modelCalls: 2,
        repairPasses: 0,
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      },
    });
  });

  it("revises rejected drafts once and re-runs the independent source critic", async () => {
    const revisedStatement =
      "The charge service records an idempotency key before publishing a payment receipt.";
    let criticRound = 0;
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
          rejectedClaims?: Array<{ claimKey: string }>;
        }>;
      };
      const subsystemKey = prompt.subsystems[0]!.subsystemKey;
      let data: unknown;
      if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: [{
            subsystemKey,
            facts: [{
              statement: `${revisedStatement} It encrypts every receipt.`,
              category: "behavior",
              confidence: "high",
              sensitivityFlag: false,
              citationIndexes: [1],
              reviewNotes: null,
              productImportance: 5,
              implementationBreadth: 3,
              technicalDifficulty: 4,
              distinctiveness: 4,
            }],
            highlights: [],
            unresolvedQuestions: [],
          }],
        };
      } else if (request.schemaName === "repository_synthesis_claim_revisions") {
        data = {
          factRevisions: [{
            claimKey: prompt.subsystems[0]!.rejectedClaims![0]!.claimKey,
            replacement: {
              statement: revisedStatement,
              category: "behavior",
              confidence: "high",
              sensitivityFlag: false,
              citationIndexes: [1],
              reviewNotes: null,
              productImportance: 5,
              implementationBreadth: 3,
              technicalDifficulty: 4,
              distinctiveness: 4,
            },
          }],
          highlightRevisions: [],
        };
      } else {
        criticRound += 1;
        data = {
          assessments: [{
            claimKey: prompt.subsystems[0]!.claims![0]!.claimKey,
            supported: criticRound === 2,
            issues: criticRound === 1 ? ["unsupported_detail"] : [],
          }],
        };
      }
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_claim_revisions",
      "repository_synthesis_entailment_critic",
    ]);
    expect(synthesis[0]?.facts).toEqual([
      expect.objectContaining({ statement: revisedStatement }),
    ]);
    expect(synthesis[0]?.coverageGaps).toEqual([]);
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([input]) =>
      input.create.inputSummary
    );
    expect(summaries.map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
      ["synthesis", 1],
      ["entailment_critic", 1],
    ]);
    expect(summaries[2]).toEqual(expect.objectContaining({
      rejectedClaimCount: 1,
      revisionContract: "rejected_claim_patch_v2_delta_critic",
    }));
    expect(summaries[1]).toEqual(expect.objectContaining({
      claimCount: 1,
      criticScope: "full_payload",
    }));
    expect(summaries[3]).toEqual(expect.objectContaining({
      claimCount: 1,
      criticScope: "changed_claims",
    }));
    const revisionPrompt = JSON.parse(generateStructuredMock.mock.calls[2]![0].userPrompt);
    expect(revisionPrompt).toMatchObject({
      revisionRound: 1,
      isFinalRevisionRound: false,
    });
    expect(revisionPrompt.subsystems[0].rejectedClaims).toHaveLength(1);
    expect(revisionPrompt.subsystems[0].notebook).toEqual([{
      index: 1,
      sourceExcerpt,
    }]);
    expect(revisionPrompt.subsystems[0]).not.toHaveProperty("priorSynthesis");
    const revisionSystemPrompt = generateStructuredMock.mock.calls[2]![0].systemPrompt;
    expect(revisionSystemPrompt).toContain(
      repositoryEvidenceBoundaryGuidance,
    );
    expect(revisionSystemPrompt).toContain(
      "A narrower scope is valid when exact source excerpts explicitly and fully support it.",
    );
    expect(revisionSystemPrompt).toContain(
      "Mere quantifier substitution without an explicitly scoped, fully supported claim",
    );
    expect(revisionSystemPrompt).not.toContain(
      "changing all or three to both or two",
    );
    expect(generateStructuredMock.mock.calls[1]![0].maxTokens).toBe(2_000);
    expect(generateStructuredMock.mock.calls[2]![0].maxTokens).toBe(4_000);
    expect(generateStructuredMock.mock.calls[0]![0].budget).toMatchObject({
      usage: { modelCalls: 4, totalTokens: 600 },
    });
    const persistedRevision = prismaMock.generationRun.update.mock.calls[2]![0].data;
    expect(persistedRevision.parsedOutput).toEqual(expect.objectContaining({
      subsystems: [expect.objectContaining({
        facts: [expect.objectContaining({
          statement: revisedStatement,
          citationIndexes: [1],
        })],
      })],
      revisionPatch: [{
          claimKey: expect.stringMatching(/:fact:1$/u),
          kind: "fact",
          replacement: expect.objectContaining({ statement: revisedStatement }),
      }],
    }));
    expect(persistedRevision.parsedOutput).not.toHaveProperty("factRevisions");
    expect(persistedRevision.resultRefs).toEqual(expect.objectContaining({
      resultAttestation: expect.objectContaining({
        claimContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        priorClaimContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        criticScope: "changed_claims",
        criticClaimCount: 1,
        criticClaimKeys: [expect.stringMatching(/:fact:1$/u)],
        criticClaimContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    }));
    expect(summaries[3]?.claimContentDigest).toBe(
      persistedRevision.resultRefs.resultAttestation.criticClaimContentDigest,
    );
  });

  it("persists a long revised highlight claim and patch losslessly", async () => {
    const longSummary = (
      "The charge service records an idempotency key before publishing a payment receipt. " +
      "This bounded repository claim remains directly supported by the cited implementation. ".repeat(12)
    ).slice(0, 900);
    let criticRound = 0;
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
          rejectedClaims?: Array<{ claimKey: string }>;
        }>;
      };
      const subsystemKey = prompt.subsystems[0]!.subsystemKey;
      const highlight = (text: string, summary: string) => ({
        text,
        summary,
        confidence: "high" as const,
        sensitivityFlag: false,
        visibility: "resume_safe" as const,
        citationIndexes: [1],
        productImportance: 5,
        implementationBreadth: 3,
        technicalDifficulty: 4,
        distinctiveness: 4,
      });
      let data: unknown;
      if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: [{
            subsystemKey,
            facts: [],
            highlights: [highlight(
              "Encrypts every receipt through the full payment lifecycle",
              "The service encrypts every receipt through a complete payment lifecycle.",
            )],
            unresolvedQuestions: [],
          }],
        };
      } else if (request.schemaName === "repository_synthesis_claim_revisions") {
        data = {
          factRevisions: [],
          highlightRevisions: [{
            claimKey: prompt.subsystems[0]!.rejectedClaims![0]!.claimKey,
            replacement: highlight(
              "Publishes idempotent payment receipts",
              longSummary,
            ),
          }],
        };
      } else {
        criticRound += 1;
        data = {
          assessments: [{
            claimKey: prompt.subsystems[0]!.claims![0]!.claimKey,
            supported: criticRound === 2,
            issues: criticRound === 1 ? ["unsupported_broad_qualifier"] : [],
          }],
        };
      }
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });

    await synthesizeRepositoryKnowledge("refresh-1");

    const persistedRevision = prismaMock.generationRun.update.mock.calls[2]![0]
      .data.parsedOutput;
    expect(persistedRevision).toEqual(expect.objectContaining({
      subsystems: [expect.objectContaining({
        highlights: [expect.objectContaining({
          text: "Publishes idempotent payment receipts",
          summary: longSummary,
          citationIndexes: [1],
        })],
      })],
      revisionPatch: [{
        claimKey: expect.stringMatching(/:highlight:1$/u),
        kind: "highlight",
        replacement: {
          text: "Publishes idempotent payment receipts",
          summary: longSummary,
          citationIndexes: [1],
        },
      }],
    }));
  });

  it("rechecks only the changed claim through a bounded second revision", async () => {
    const latencyStatement =
      "The charge service records request latency for diagnostics.";
    const correctedPaymentStatement =
      "The charge service records an idempotency key before publishing a payment receipt.";
    const receiptStatement =
      "The charge service publishes a payment receipt.";
    let criticRound = 0;
    let revisionRound = 0;
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
          rejectedClaims?: Array<{ claimKey: string }>;
        }>;
      };
      const subsystemKey = prompt.subsystems[0]!.subsystemKey;
      const fact = (factStatement: string, citationIndexes: number[]) => ({
        statement: factStatement,
        category: "behavior" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        citationIndexes,
        reviewNotes: null,
        productImportance: 4,
        implementationBreadth: 2,
        technicalDifficulty: 2,
        distinctiveness: 2,
      });
      let data: unknown;
      if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: [{
            subsystemKey,
            facts: [
              fact(latencyStatement, [2]),
              fact(`${correctedPaymentStatement} It encrypts every receipt.`, [1]),
              fact(receiptStatement, [1]),
            ],
            highlights: [],
            unresolvedQuestions: [],
          }],
        };
      } else if (request.schemaName === "repository_synthesis_claim_revisions") {
        revisionRound += 1;
        const rejectedClaimKey = prompt.subsystems[0]!.rejectedClaims![0]!.claimKey;
        data = {
          factRevisions: [{
            claimKey: rejectedClaimKey,
            replacement: revisionRound === 1
              ? fact(
                  `${correctedPaymentStatement} It encrypts payment receipts.`,
                  [1],
                )
              : fact(correctedPaymentStatement, [1]),
          }],
          highlightRevisions: [],
        };
      } else {
        const claims = prompt.subsystems[0]!.claims!;
        if (criticRound === 0) {
          data = {
            assessments: claims.map((claim) => ({
              claimKey: claim.claimKey,
              supported: claim.claimKey !== `${subsystemKey}:fact:2`,
              issues: claim.claimKey === `${subsystemKey}:fact:2`
                ? ["unsupported_detail"]
                : [],
            })),
          };
        } else {
          expect(claims).toHaveLength(1);
          expect(claims[0]?.claimKey).toBe(`${subsystemKey}:fact:2`);
          data = {
            assessments: [{
              claimKey: claims[0]!.claimKey,
              supported: criticRound === 2,
              issues: criticRound === 1 ? ["unsupported_detail"] : [],
            }],
          };
        }
        criticRound += 1;
      }
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_claim_revisions",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_claim_revisions",
      "repository_synthesis_entailment_critic",
    ]);
    expect(synthesis[0]?.facts.map((candidate) => candidate.statement)).toEqual([
      latencyStatement,
      correctedPaymentStatement,
      receiptStatement,
    ]);
    expect(synthesis[0]?.coverageGaps).toEqual([]);
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([request]) =>
      request.create.inputSummary
    );
    expect(summaries.map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
      ["synthesis", 1],
      ["entailment_critic", 1],
      ["synthesis", 2],
      ["entailment_critic", 2],
    ]);
    expect(summaries[4]).toEqual(expect.objectContaining({
      rejectedClaimCount: 1,
      revisionContract: "rejected_claim_patch_v2_delta_critic",
    }));
    expect(summaries[1]).toEqual(expect.objectContaining({
      claimCount: 3,
      criticScope: "full_payload",
    }));
    expect(summaries[3]).toEqual(expect.objectContaining({
      claimCount: 1,
      criticScope: "changed_claims",
    }));
    expect(summaries[5]).toEqual(expect.objectContaining({
      claimCount: 1,
      criticScope: "changed_claims",
    }));
    const firstRevisionPrompt = JSON.parse(
      generateStructuredMock.mock.calls[2]![0].userPrompt,
    );
    const secondRevisionPrompt = JSON.parse(
      generateStructuredMock.mock.calls[4]![0].userPrompt,
    );
    expect(firstRevisionPrompt).toMatchObject({
      revisionRound: 1,
      isFinalRevisionRound: false,
    });
    expect(secondRevisionPrompt).toMatchObject({
      revisionRound: 2,
      isFinalRevisionRound: true,
    });
    expect(firstRevisionPrompt.subsystems[0].rejectedClaims.map(
      (claim: { claimKey: string }) => claim.claimKey,
    )).toEqual([expect.stringMatching(/:fact:2$/u)]);
    expect(firstRevisionPrompt.subsystems[0].notebook).toEqual([{
      index: 1,
      sourceExcerpt,
    }]);
    expect(secondRevisionPrompt.subsystems[0].rejectedClaims.map(
      (claim: { claimKey: string }) => claim.claimKey,
    )).toEqual([expect.stringMatching(/:fact:2$/u)]);
    expect(secondRevisionPrompt.subsystems[0].notebook).toEqual([{
      index: 1,
      sourceExcerpt,
    }]);
    expect(generateStructuredMock.mock.calls[4]![0].systemPrompt).toContain(
      repositoryEvidenceBoundaryGuidance,
    );
    expect(generateStructuredMock.mock.calls[4]![0].systemPrompt).toMatch(
      /final bounded revision round[\s\S]*(?:replacement to null|return null)/iu,
    );
    expect(generateStructuredMock.mock.calls[0]![0].budget).toMatchObject({
      usage: { modelCalls: 6, totalTokens: 900 },
    });
    const persistedSecondRevision = prismaMock.generationRun.update.mock.calls[4]![0].data;
    expect(persistedSecondRevision.parsedOutput).toEqual(expect.objectContaining({
      subsystems: [expect.objectContaining({
        facts: [
          expect.objectContaining({ statement: latencyStatement }),
          expect.objectContaining({ statement: correctedPaymentStatement }),
          expect.objectContaining({ statement: receiptStatement }),
        ],
      })],
      revisionPatch: [{
          claimKey: expect.stringMatching(/:fact:2$/u),
          kind: "fact",
          replacement: expect.objectContaining({
            statement: correctedPaymentStatement,
          }),
      }],
    }));
    expect(persistedSecondRevision.resultRefs).toEqual(expect.objectContaining({
      resultAttestation: expect.objectContaining({
        claimContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        criticClaimCount: 1,
        criticClaimKeys: [expect.stringMatching(/:fact:2$/u)],
        criticClaimContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    }));
    expect(
      persistedSecondRevision.resultRefs.resultAttestation
        .criticClaimContentDigest,
    ).not.toBe(
      persistedSecondRevision.resultRefs.resultAttestation.claimContentDigest,
    );
  });

  it("skips an empty delta critic after removal and retains accepted siblings", async () => {
    const acceptedStatement =
      "The charge service records request latency for diagnostics.";
    const rejectedStatement =
      "The charge service encrypts every payment receipt.";
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
          rejectedClaims?: Array<{ claimKey: string }>;
        }>;
      };
      const subsystemKey = prompt.subsystems[0]!.subsystemKey;
      const fact = (factStatement: string, citationIndexes: number[]) => ({
        statement: factStatement,
        category: "behavior" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        citationIndexes,
        reviewNotes: null,
        productImportance: 4,
        implementationBreadth: 2,
        technicalDifficulty: 2,
        distinctiveness: 2,
      });
      let data: unknown;
      if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: [{
            subsystemKey,
            facts: [
              fact(acceptedStatement, [2]),
              fact(rejectedStatement, [1]),
            ],
            highlights: [],
            unresolvedQuestions: [],
          }],
        };
      } else if (request.schemaName === "repository_synthesis_claim_revisions") {
        data = {
          factRevisions: [{
            claimKey: prompt.subsystems[0]!.rejectedClaims![0]!.claimKey,
            replacement: null,
          }],
          highlightRevisions: [],
        };
      } else {
        data = {
          assessments: prompt.subsystems[0]!.claims!.map((claim) => ({
            claimKey: claim.claimKey,
            supported: claim.claimKey.endsWith(":fact:1"),
            issues: claim.claimKey.endsWith(":fact:1")
              ? []
              : ["unsupported_detail"],
          })),
        };
      }
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_claim_revisions",
    ]);
    expect(synthesis[0]?.facts.map((candidate) => candidate.statement)).toEqual([
      acceptedStatement,
    ]);
    expect(synthesis[0]?.coverageGaps).toEqual([]);
    expect(synthesis[0]?.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 2 in revision round 1: unsupported detail.",
    );
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([request]) =>
      request.create.inputSummary
    );
    expect(summaries.map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
      ["synthesis", 1],
    ]);
    const persistedRevision = prismaMock.generationRun.update.mock.calls[2]![0].data;
    expect(persistedRevision.parsedOutput).toEqual(expect.objectContaining({
      revisionPatch: [{
          claimKey: expect.stringMatching(/:fact:2$/u),
          kind: "fact",
          replacement: null,
      }],
    }));
    expect(persistedRevision.resultRefs.resultAttestation).toEqual(
      expect.objectContaining({
        criticScope: "changed_claims",
        criticClaimCount: 0,
        criticClaimKeys: [],
        criticClaimContentDigest: null,
        priorClaimContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(generateStructuredMock.mock.calls[0]![0].budget).toMatchObject({
      usage: { modelCalls: 3, totalTokens: 450 },
    });
  });

  it("fails closed after the second critic without starting a third revision", async () => {
    const firstRevisionStatement =
      "The charge service records an idempotency key before publishing a payment receipt and encrypts receipts.";
    const secondRevisionStatement =
      "The charge service records an idempotency key before publishing a payment receipt.";
    let revisionRound = 0;
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
          rejectedClaims?: Array<{ claimKey: string }>;
        }>;
      };
      const subsystemKey = prompt.subsystems[0]!.subsystemKey;
      const fact = (factStatement: string) => ({
        statement: factStatement,
        category: "behavior" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        citationIndexes: [1],
        reviewNotes: null,
        productImportance: 5,
        implementationBreadth: 3,
        technicalDifficulty: 4,
        distinctiveness: 4,
      });
      let data: unknown;
      if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: [{
            subsystemKey,
            facts: [fact(`${statement} It encrypts every receipt.`)],
            highlights: [],
            unresolvedQuestions: [],
          }],
        };
      } else if (request.schemaName === "repository_synthesis_claim_revisions") {
        revisionRound += 1;
        data = {
          factRevisions: [{
            claimKey: prompt.subsystems[0]!.rejectedClaims![0]!.claimKey,
            replacement: fact(
              revisionRound === 1
                ? firstRevisionStatement
                : secondRevisionStatement,
            ),
          }],
          highlightRevisions: [],
        };
      } else {
        data = {
          assessments: prompt.subsystems[0]!.claims!.map((claim) => ({
            claimKey: claim.claimKey,
            supported: false,
            issues: ["unsupported_detail"],
          })),
        };
      }
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_claim_revisions",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_claim_revisions",
      "repository_synthesis_entailment_critic",
    ]);
    expect(revisionRound).toBe(2);
    expect(synthesis[0]?.facts).toEqual([]);
    expect(synthesis[0]?.coverageGaps).toEqual([
      expect.stringMatching(
        /^Repository acme\/ledger-platform produced no supported Project Facts for project_domain:payments/u,
      ),
    ]);
    expect(synthesis[0]?.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 1: unsupported detail.",
    );
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([request]) =>
      request.create.inputSummary
    );
    expect(summaries.map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
      ["synthesis", 1],
      ["entailment_critic", 1],
      ["synthesis", 2],
      ["entailment_critic", 2],
    ]);
  });

  it("reserves two bounded revisions and native synthesis headroom under one 80K cap", () => {
    expect(repositorySynthesisBudgetLimits(3)).toEqual({
      maxModelCalls: 24,
      maxRepairPasses: 6,
      maxOutputTokens: 10_000,
      maxTotalTokens: 80_000,
    });
    expect(() => repositorySynthesisBudgetLimits(-1)).toThrow(
      "Repository synthesis batch count must be a non-negative integer.",
    );
  });
});
