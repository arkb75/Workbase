import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredGenerationBudget } from "@/src/lib/bedrock-structured-llm-client";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

const generateStructuredMock = vi.hoisted(() => vi.fn());
const requestedClientProfiles = vi.hoisted(() => [] as string[]);
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
  getStructuredLlmClient: (profile: string) => {
    return ({
      generateStructured: async (input: {
        schemaName: string;
        userPrompt: string;
        extraValidation?: (value: unknown) => string[];
      }) => {
        if (input.schemaName === "repository_highlight_selection") {
          const prompt = JSON.parse(input.userPrompt) as {
            candidates: Array<{ candidateId: string }>;
          };
          const data = {
            selections: [],
            omissions: prompt.candidates.map(({ candidateId }) => ({
              candidateId,
              reason: "lower_relative_salience",
            })),
          };
          const errors = input.extraValidation?.(data) ?? [];
          if (errors.length) throw new Error(errors.join(" "));
          return {
            data,
            rawOutput: JSON.stringify(data),
            parsedOutput: data,
            tokenUsage: null,
            provider: "bedrock",
            modelId: "synthesis-model",
            transportMode: "bedrock_json_schema",
            attempts: [{ status: "success" }],
          };
        }
        requestedClientProfiles.push(profile);
        return generateStructuredMock(input);
      },
    });
  },
}));

import {
  REPOSITORY_SYNTHESIS_REVISION_PAIR_MODEL_CALLS,
  REPOSITORY_SYNTHESIS_REVISION_PAIR_REPAIR_PASSES,
  repositoryEvidenceBoundaryGuidance,
  repositorySynthesisBudgetLimits,
  repositorySynthesisRevisionPairFits,
  repositorySynthesisRevisionPairTokenReserve,
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
    requestedClientProfiles.length = 0;
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
          claims?: Array<{ claimKey: string; kind: "fact" | "highlight" }>;
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
    expect(requestedClientProfiles).toEqual(["deep_synthesis", "verification"]);
    expect(generateStructuredMock.mock.calls[0]![0]).toMatchObject({
      maxTokens: 2_000,
      effort: "low",
    });
    expect(generateStructuredMock.mock.calls[1]![0]).toMatchObject({
      maxTokens: 2_000,
      effort: "low",
      enablePromptCaching: false,
    });
    const synthesisPrompt = JSON.parse(generateStructuredMock.mock.calls[0]![0].userPrompt);
    const criticPrompt = JSON.parse(generateStructuredMock.mock.calls[1]![0].userPrompt);
    expect(synthesisPrompt.subsystems[0].claimLimits).toEqual({
      maxFacts: 2,
      maxHighlights: 0,
    });
    expect(synthesisPrompt.subsystems[0].notebook[0].sourceExcerpt).toBe(sourceExcerpt);
    expect(synthesisPrompt.subsystems[0].notebook[0]).not.toHaveProperty("sourceId");
    expect(synthesisPrompt.subsystems[0].notebook[0]).not.toHaveProperty("repository");
    expect(synthesisPrompt.subsystems[0].notebook[0]).not.toHaveProperty("commitSha");
    expect(synthesisPrompt.subsystems[0].notebook[0]).not.toHaveProperty("blobSha");
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
    expect(generateStructuredMock.mock.calls[0]![0].systemPrompt).toContain(
      "Return an empty highlights array",
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
      expect.objectContaining({
        phase: "repository_highlight_selection",
        refreshRunId: "refresh-1",
        candidateCount: 1,
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

  it("maps a capped product domain into bounded, auditable operation communities", async () => {
    const broadRun = refreshRun();
    broadRun.snapshots[0]!.files = Array.from({ length: 37 }, (_entry, index) => {
      const operationPath = `src/domain/operation-${index + 1}-service.ts`;
      const operationStatement =
        `Operation ${index + 1} applies a distinct supported state transition for the project.`;
      const operationFact = {
        statement: operationStatement,
        category: "behavior" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        lineStart: 1,
        lineEnd: 2,
        productImportance: 4,
        implementationBreadth: 3,
        technicalDifficulty: 3,
        path: operationPath,
        subsystemKeys: ["project_domain:payments"],
        semanticSignals: [],
        semanticKind: "user_capability" as const,
        evidenceExcerpt: `1: export function operation${index + 1}() {\n2:   return transition();`,
        evidenceMode: "semantic" as const,
      };
      return {
        path: operationPath,
        blobSha: `blob-operation-${index + 1}`,
        analyzerVersion: null,
        analysis: null,
        semanticRefreshRunId: "refresh-1",
        semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
        semanticStatus: "succeeded",
        semanticAnalysis: {
          ...semanticAnalysis(),
          path: operationPath,
          summary: operationStatement,
          // The first file repeats the same extracted observation. Mapping
          // telemetry must count unique eligible evidence, not raw duplicates.
          facts: index === 0
            ? [operationFact, { ...operationFact }]
            : [operationFact],
        },
        changeType: "modified",
      };
    });
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue(broadRun);
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
        observations?: Array<{ index: number }>;
        subsystems?: Array<{
          subsystemKey: string;
          operationCommunity?: string | null;
          notebook?: Array<{ statement: string }>;
          claims?: Array<{ claimKey: string }>;
        }>;
      };
      let data: unknown;
      if (request.schemaName === "repository_operation_communities") {
        data = {
          communities: [
            { label: "Account state transitions", memberIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
            { label: "Settlement state transitions", memberIndexes: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] },
            { label: "Reporting state transitions", memberIndexes: [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36] },
          ],
        };
      } else if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: prompt.subsystems!.map((subsystem) => ({
            subsystemKey: subsystem.subsystemKey,
            facts: [{
              statement: subsystem.notebook![0]!.statement,
              category: "behavior",
              confidence: "high",
              sensitivityFlag: false,
              citationIndexes: [1],
              reviewNotes: null,
              productImportance: 4,
              implementationBreadth: 3,
              technicalDifficulty: 3,
              distinctiveness: 4,
            }],
            highlights: [],
            unresolvedQuestions: [],
          })),
        };
      } else {
        data = {
          assessments: prompt.subsystems!.flatMap((subsystem) =>
            subsystem.claims!.map((claim) => ({
              claimKey: claim.claimKey,
              supported: true,
              issues: [],
            }))
          ),
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
        requestId: `request-${request.schemaName}`,
      };
    });

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_operation_communities",
      "repository_architecture_synthesis",
      "repository_architecture_synthesis",
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_entailment_critic",
      "repository_synthesis_entailment_critic",
    ]);
    const mappingPrompt = JSON.parse(generateStructuredMock.mock.calls[0]![0].userPrompt);
    const synthesisSubsystems = generateStructuredMock.mock.calls
      .filter(([request]) => request.schemaName === "repository_architecture_synthesis")
      .flatMap(([request]) => JSON.parse(request.userPrompt).subsystems);
    expect(mappingPrompt.observations).toHaveLength(36);
    expect(mappingPrompt.observations[0]).toEqual(expect.objectContaining({
      index: 1,
      path: "src/domain/operation-1-service.ts",
      statement: expect.any(String),
      semanticKind: "user_capability",
      semanticSignals: [],
      category: "behavior",
    }));
    expect(mappingPrompt.observations[0]).not.toHaveProperty("productImportance");
    expect(mappingPrompt.observations[0]).not.toHaveProperty("implementationBreadth");
    expect(mappingPrompt.observations[0]).not.toHaveProperty("technicalDifficulty");
    expect(new Set(synthesisSubsystems.map((subsystem: { operationCommunity: string }) =>
      subsystem.operationCommunity
    ))).toEqual(new Set([
      "Account state transitions",
      "Settlement state transitions",
      "Reporting state transitions",
    ]));
    expect(synthesisSubsystems.map((subsystem: { notebook: unknown[] }) =>
      subsystem.notebook.length
    )).toEqual([12, 12, 12]);
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([input]) =>
      input.create.inputSummary
    );
    expect(summaries[0]).toMatchObject({
      phase: "operation_community_mapping",
      capabilityKey: "project_domain:payments",
      communityPolicy: "project_domain_v1",
      notebookEntries: 36,
      rawEligibleEntries: 37,
      expectedCommunityCount: 3,
    });
    const synthesisSummaries = summaries.filter((summary) => summary.phase === "synthesis");
    const consumedCommunities = synthesisSummaries.flatMap((summary) =>
      summary.operationCommunities
    );
    expect(consumedCommunities).toHaveLength(3);
    expect(consumedCommunities.map((community) => community.communityIndex).sort()).toEqual([0, 1, 2]);
    expect(consumedCommunities.every((community) =>
      community.parentSynthesisKey === summaries[0].subsystemKey &&
      /^[a-f0-9]{64}$/.test(community.mappingDigest) &&
      community.memberIndexes.length === 12
    )).toBe(true);
    for (const summary of synthesisSummaries) {
      expect(new Set(summary.subsystemKeys)).toEqual(new Set(
        summary.operationCommunities.map((community: { childSynthesisKey: string }) =>
          community.childSynthesisKey
        ),
      ));
    }
    expect(new Set(consumedCommunities.map((community) => community.mappingDigest)).size).toBe(1);
    expect(synthesis).toHaveLength(3);
    expect(synthesis.every((entry) =>
      entry.subsystemKey === "project_domain:payments" && entry.facts.length === 1
    )).toBe(true);
    expect(synthesis.some((entry) => entry.unresolvedQuestions.some((question) =>
      question.includes("covered 36 of 37 eligible semantic observations")
    ))).toBe(true);
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
          claims?: Array<{ claimKey: string; kind: "fact" | "highlight" }>;
          rejectedClaims?: Array<{ claimKey: string; revisionSlot: string }>;
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
          factReplacements: {
            [prompt.subsystems[0]!.rejectedClaims![0]!.revisionSlot]: {
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
          },
          highlightTitleReplacements: {},
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
    expect(summaries.filter((summary) => summary.phase !== "repository_highlight_selection")
      .map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
      ["synthesis", 1],
      ["entailment_critic", 1],
    ]);
    expect(summaries[2]).toEqual(expect.objectContaining({
      rejectedClaimCount: 1,
      revisionContract: "rejected_claim_patch_v3_server_slots",
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
    expect(generateStructuredMock.mock.calls[0]![0].maxTokens).toBe(2_000);
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

  it("revises only the first deterministic rejected Fact when every Fact is rejected", async () => {
    const priorStatements = [
      `${statement} It encrypts every receipt.`,
      "The charge service records latency and guarantees zero downtime.",
    ];
    const revisedStatements = [
      statement,
      "The charge service records request latency for diagnostics.",
    ];
    let criticRound = 0;
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } };
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
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
        productImportance: 4,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        distinctiveness: 3,
      });
      let data: unknown;
      if (request.schemaName === "repository_architecture_synthesis") {
        data = {
          subsystems: [{
            subsystemKey,
            facts: priorStatements.map(fact),
            highlights: [],
            unresolvedQuestions: [],
          }],
        };
      } else if (request.schemaName === "repository_synthesis_claim_revisions") {
        const wrongSlots = request.schema.safeParse({
          factReplacements: {
            F2: fact(revisedStatements[1]!),
          },
          highlightTitleReplacements: {},
        });
        expect(wrongSlots.success).toBe(false);
        expect(wrongSlots.error?.issues.map((issue) => issue.message)).toContain(
          "Fact replacement slots must match exactly; missing [F1], unexpected [F2].",
        );
        data = {
          factReplacements: {
            F1: fact(revisedStatements[0]!),
          },
          highlightTitleReplacements: {},
        };
      } else {
        criticRound += 1;
        data = {
          assessments: prompt.subsystems[0]!.claims!.map((claim) => ({
            claimKey: claim.claimKey,
            supported: criticRound === 2,
            issues: criticRound === 1 ? ["unsupported_detail"] : [],
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

    expect(synthesis[0]?.facts.map((candidate) => candidate.statement)).toEqual([
      revisedStatements[0],
    ]);
    const revisionPatch = prismaMock.generationRun.update.mock.calls[2]![0]
      .data.parsedOutput.revisionPatch;
    expect(revisionPatch.map((candidate: { claimKey: string; replacement: { statement: string } }) => [
      candidate.claimKey.match(/:fact:(\d+)$/u)?.[1],
      candidate.replacement.statement,
    ])).toEqual([["1", revisedStatements[0]]]);
  });

  it("does not revise a rejected Fact when supported siblings already satisfy the floor", async () => {
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
          rejectedClaims?: Array<{ claimKey: string; revisionSlot: string }>;
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
        const revisionSlot = prompt.subsystems[0]!.rejectedClaims![0]!.revisionSlot;
        data = {
          factReplacements: {
            [revisionSlot]: revisionRound === 1
              ? fact(
                  `${correctedPaymentStatement} It encrypts payment receipts.`,
                  [1],
                )
              : fact(correctedPaymentStatement, [1]),
          },
          highlightTitleReplacements: {},
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
    ]);
    expect(synthesis[0]?.facts.map((candidate) => candidate.statement)).toEqual([
      latencyStatement,
    ]);
    expect(synthesis[0]?.coverageGaps).toEqual([]);
    expect(synthesis[0]?.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 2: unsupported detail.",
    );
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([request]) =>
      request.create.inputSummary
    );
    expect(summaries.filter((summary) => summary.phase !== "repository_highlight_selection")
      .map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
    ]);
    expect(summaries[1]).toEqual(expect.objectContaining({
      claimCount: 2,
      criticScope: "full_payload",
    }));
    expect(generateStructuredMock.mock.calls[0]![0].budget).toMatchObject({
      usage: { modelCalls: 2, totalTokens: 300 },
    });
  });

  it("drops rejected siblings without revision when the subsystem retains a supported Fact", async () => {
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
          rejectedClaims?: Array<{ claimKey: string; revisionSlot: string }>;
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
          factReplacements: {
            [prompt.subsystems[0]!.rejectedClaims![0]!.revisionSlot]: null,
          },
          highlightTitleReplacements: {},
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
    ]);
    expect(synthesis[0]?.facts.map((candidate) => candidate.statement)).toEqual([
      acceptedStatement,
    ]);
    expect(synthesis[0]?.coverageGaps).toEqual([]);
    expect(synthesis[0]?.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 2: unsupported detail.",
    );
    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([request]) =>
      request.create.inputSummary
    );
    expect(summaries.filter((summary) => summary.phase !== "repository_highlight_selection")
      .map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
    ]);
    expect(generateStructuredMock.mock.calls[0]![0].budget).toMatchObject({
      usage: { modelCalls: 2, totalTokens: 300 },
    });
    expect(prismaMock.generationRun.upsert).toHaveBeenCalledTimes(3);
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
          rejectedClaims?: Array<{ claimKey: string; revisionSlot: string }>;
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
          factReplacements: {
            [prompt.subsystems[0]!.rejectedClaims![0]!.revisionSlot]: fact(
              revisionRound === 1
                ? firstRevisionStatement
                : secondRevisionStatement,
            ),
          },
          highlightTitleReplacements: {},
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
    expect(summaries.filter((summary) => summary.phase !== "repository_highlight_selection")
      .map((summary) => [summary.phase, summary.revisionRound])).toEqual([
      ["synthesis", 0],
      ["entailment_critic", 0],
      ["synthesis", 1],
      ["entailment_critic", 1],
      ["synthesis", 2],
      ["entailment_critic", 2],
    ]);
  });

  it("skips optional refinement when the native revision and critic pair cannot fit", async () => {
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      if (request.budget) {
        request.budget.usage.modelCalls += 1;
        request.budget.usage.inputTokens += 34_500;
        request.budget.usage.outputTokens += 1_000;
        request.budget.usage.totalTokens += 35_500;
      }
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
        }>;
      };
      const data = request.schemaName === "repository_architecture_synthesis"
        ? {
            subsystems: [{
              subsystemKey: prompt.subsystems[0]!.subsystemKey,
              facts: [{
                statement: `${statement} It encrypts every receipt.`,
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
              supported: false,
              issues: ["unsupported_detail"],
            }],
          };
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: { inputTokens: 34_500, outputTokens: 1_000, totalTokens: 35_500 },
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
    ]);
    expect(synthesis[0]?.facts).toEqual([]);
    expect(synthesis[0]?.unresolvedQuestions).toEqual(expect.arrayContaining([
      "Entailment verification rejected fact 1: unsupported detail.",
      expect.stringContaining(
        "did not have enough reserved synthesis budget for both revision and independent re-critique",
      ),
    ]));
    expect(prismaMock.generationRun.upsert).toHaveBeenCalledTimes(2);
  });

  it("admits the native revision and mandatory critic without pre-spending repair capacity", () => {
    const tokenReserve = repositorySynthesisRevisionPairTokenReserve({
      projectTitle: "Ledger Platform",
      revisionRound: 1,
      provider: "openrouter",
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        notebook: [{ index: 1, sourceExcerpt }],
        rejectedClaims: [{
          claimKey: "project_domain:payments#scope:fact:1",
          kind: "fact",
        }],
      }],
    });
    const bedrockTokenReserve = repositorySynthesisRevisionPairTokenReserve({
      projectTitle: "Ledger Platform",
      revisionRound: 1,
      provider: "bedrock",
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        notebook: [{ index: 1, sourceExcerpt }],
        rejectedClaims: [{
          claimKey: "project_domain:payments#scope:fact:1",
          kind: "fact",
        }],
      }],
    });
    const budget: StructuredGenerationBudget = {
      limits: repositorySynthesisBudgetLimits(1),
      usage: {
        modelCalls: 2,
        repairPasses: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 80_000 - tokenReserve,
        unknownUsageCalls: 0,
      },
    };

    expect(tokenReserve).toBeGreaterThan(6_000);
    expect(bedrockTokenReserve).toBeGreaterThan(tokenReserve);
    expect(REPOSITORY_SYNTHESIS_REVISION_PAIR_MODEL_CALLS).toBe(2);
    expect(REPOSITORY_SYNTHESIS_REVISION_PAIR_REPAIR_PASSES).toBe(0);
    expect(repositorySynthesisRevisionPairFits(budget, tokenReserve)).toBe(true);
    budget.usage.totalTokens += 1;
    expect(repositorySynthesisRevisionPairFits(budget, tokenReserve)).toBe(false);
    budget.usage.totalTokens -= 1;
    budget.usage.modelCalls =
      budget.limits.maxModelCalls -
      REPOSITORY_SYNTHESIS_REVISION_PAIR_MODEL_CALLS +
      1;
    expect(repositorySynthesisRevisionPairFits(budget, tokenReserve)).toBe(false);
    budget.usage.modelCalls = 2;
    budget.usage.repairPasses = budget.limits.maxRepairPasses;
    expect(repositorySynthesisRevisionPairFits(budget, tokenReserve)).toBe(true);
  });

  it("keeps the 80K floor and scales required batch headroom", () => {
    expect(repositorySynthesisBudgetLimits(3)).toEqual({
      maxModelCalls: 21,
      maxRepairPasses: 3,
      maxOutputTokens: 10_000,
      maxTotalTokens: 80_000,
    });
    expect(repositorySynthesisBudgetLimits(5)).toEqual({
      maxModelCalls: 35,
      maxRepairPasses: 5,
      maxOutputTokens: 10_000,
      maxTotalTokens: 100_000,
    });
    expect(() => repositorySynthesisBudgetLimits(-1)).toThrow(
      "Repository synthesis batch count must be a non-negative integer.",
    );
  });
});
